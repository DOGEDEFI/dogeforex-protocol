import { expect } from "chai";
import { ethers } from "hardhat";
import {
  GenesisBootstrapSale,
  GuardianTimelock,
  MintingHub,
  OracleFreeDollar,
} from "../typechain";
import { evm_increaseTime } from "./helper";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("GenesisBootstrapSale", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let ofd: OracleFreeDollar;
  let bootstrap: GenesisBootstrapSale;
  let endTime: number;

  const POOL_SEED = 100_000n * 10n ** 18n;
  const EQUITY = 250_000n * 10n ** 18n;
  const BOUNTY = 50_000n * 10n ** 18n;
  const INCENTIVES = 100_000n * 10n ** 18n;
  const FLOAT = POOL_SEED + EQUITY + BOUNTY + INCENTIVES;

  beforeEach(async () => {
    [owner, alice] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("OracleFreeDollar");
    ofd = await factory.deploy(10 * 86400, "DogeForex Dollar", "K9USD");
    endTime = (await ethers.provider.getBlock("latest"))!.timestamp + 28 * 86400;
    const bootstrapFactory = await ethers.getContractFactory("GenesisBootstrapSale");
    bootstrap = await bootstrapFactory.deploy(
      await ofd.getAddress(),
      endTime,
      owner.address, // pool seed
      alice.address, // equity
      owner.address, // challenger bounty
      alice.address, // incentives
      POOL_SEED,
      EQUITY,
      BOUNTY,
      INCENTIVES
    );
  });

  it("is a permanent minter once registered via initialize", async () => {
    await expect(ofd.initialize(await bootstrap.getAddress(), "Genesis Bootstrap"))
      .to.emit(ofd, "MinterApplied")
      .withArgs(await bootstrap.getAddress(), 0, 0, "Genesis Bootstrap");
    expect(await ofd.isMinter(await bootstrap.getAddress())).to.be.true;
  });

  it("executes exactly once, minting the full allocation split to the recipients", async () => {
    await ofd.initialize(await bootstrap.getAddress(), "Genesis Bootstrap");
    await expect(bootstrap.connect(alice).execute())
      .to.emit(bootstrap, "BootstrapExecuted")
      .withArgs(
        alice.address,
        owner.address,
        POOL_SEED,
        alice.address,
        EQUITY,
        owner.address,
        BOUNTY,
        alice.address,
        INCENTIVES
      );
    expect(await bootstrap.executed()).to.be.true;
    expect(await bootstrap.totalFloat()).to.equal(FLOAT);
    expect(await ofd.totalSupply()).to.equal(FLOAT);
    expect(await ofd.balanceOf(owner.address)).to.equal(POOL_SEED + BOUNTY);
    expect(await ofd.balanceOf(alice.address)).to.equal(EQUITY + INCENTIVES);
    await expect(bootstrap.execute()).to.be.revertedWithCustomError(bootstrap, "AlreadyExecuted");
  });

  it("reverts after endTime (float forfeited)", async () => {
    await ofd.initialize(await bootstrap.getAddress(), "Genesis Bootstrap");
    await evm_increaseTime(28 * 86400 + 1);
    await expect(bootstrap.execute()).to.be.revertedWithCustomError(bootstrap, "SaleExpired");
  });
});

describe("GuardianTimelock admission gate", () => {
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let ofd: OracleFreeDollar;
  let hub: MintingHub;
  let timelock: GuardianTimelock;

  beforeEach(async () => {
    [owner, alice, bob] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("OracleFreeDollar");
    ofd = await factory.deploy(10 * 86400, "DogeForex Dollar", "K9USD");
    const factoryFactory = await ethers.getContractFactory("PositionFactory");
    const positionFactory = await factoryFactory.deploy();
    const rollerFactory = await ethers.getContractFactory("PositionRoller");
    const roller = await rollerFactory.deploy(await ofd.getAddress());
    const savingsFactory = await ethers.getContractFactory("Savings");
    const savings = await savingsFactory.deploy(await ofd.getAddress(), 50000);
    const hubFactory = await ethers.getContractFactory("MintingHub");
    hub = await hubFactory.deploy(
      await ofd.getAddress(),
      await savings.getAddress(),
      await roller.getAddress(),
      await positionFactory.getAddress()
    );
    const timelockFactory = await ethers.getContractFactory("GuardianTimelock");
    timelock = await timelockFactory.deploy(alice.address); // alice = Ops Safe
  });

  it("gate is open when no guardian is set (default behavior)", async () => {
    expect(await ofd.guardian()).to.equal(ethers.ZeroAddress);
    // gate must not block: suggestMinter proceeds to the body (PeriodTooShort, not AdmissionPaused)
    await expect(ofd.suggestMinter(bob.address, 1, 1, "")).to.be.revertedWithCustomError(
      ofd,
      "PeriodTooShort"
    );
  });

  it("setGuardian is deployer-gated and one-shot", async () => {
    await expect(ofd.connect(bob).setGuardian(await timelock.getAddress()))
      .to.be.revertedWithCustomError(ofd, "NotDeployer");
    await expect(ofd.setGuardian(await timelock.getAddress()))
      .to.emit(ofd, "GuardianSet")
      .withArgs(await timelock.getAddress());
    expect(await ofd.guardian()).to.equal(await timelock.getAddress());
    await expect(ofd.setGuardian(bob.address)).to.be.revertedWithCustomError(
      ofd,
      "GuardianAlreadySet"
    );
  });

  it("pause blocks new admissions only; transfers and minting never pause", async () => {
    await ofd.setGuardian(await timelock.getAddress());
    await expect(timelock.connect(bob).pause()).to.be.revertedWithCustomError(timelock, "NotGuardian");
    await timelock.connect(alice).pause();
    expect(await timelock.paused()).to.be.true;

    // suggestMinter blocked
    await expect(ofd.suggestMinter(bob.address, 10 * 86400, 1000n * 10n ** 18n, ""))
      .to.be.revertedWithCustomError(ofd, "AdmissionPaused");
    // openPosition and clone blocked (modifier runs before any collateral validation)
    await expect(
      hub.openPosition(ethers.ZeroAddress, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    ).to.be.revertedWithCustomError(hub, "AdmissionPaused");
    await expect(hub.clone(ethers.ZeroAddress, 0, 0, 0)).to.be.revertedWithCustomError(
      hub,
      "AdmissionPaused"
    );

    // transfers and bootstrap minting remain possible while paused
    const endTime = (await ethers.provider.getBlock("latest"))!.timestamp + 28 * 86400;
    const bootstrapFactory = await ethers.getContractFactory("GenesisBootstrapSale");
    const bootstrap = await bootstrapFactory.deploy(
      await ofd.getAddress(),
      endTime,
      owner.address,
      alice.address,
      owner.address,
      alice.address,
      1000n * 10n ** 18n,
      0,
      0,
      0
    );
    await ofd.initialize(await bootstrap.getAddress(), "Genesis Bootstrap");
    await bootstrap.execute();
    await ofd.transfer(bob.address, 1000n * 10n ** 18n);
    expect(await ofd.balanceOf(bob.address)).to.equal(1000n * 10n ** 18n);
  });

  it("unpause requires the 72h timelock", async () => {
    await ofd.setGuardian(await timelock.getAddress());
    await timelock.connect(alice).pause();
    await expect(timelock.connect(alice).unpause()).to.be.revertedWithCustomError(
      timelock,
      "TimelockPending"
    );
    await timelock.connect(alice).scheduleUnpause();
    await evm_increaseTime(72 * 3600);
    await expect(timelock.connect(alice).unpause()).to.emit(timelock, "Unpaused");
    expect(await timelock.paused()).to.be.false;
    // gate open again
    await expect(ofd.suggestMinter(bob.address, 1, 1, "")).to.be.revertedWithCustomError(
      ofd,
      "PeriodTooShort"
    );
  });

  it("guardian rotation goes through the 72h timelock", async () => {
    await ofd.setGuardian(await timelock.getAddress());
    await timelock.connect(alice).scheduleGuardianRotation(bob.address);
    await expect(timelock.connect(alice).rotateGuardian()).to.be.revertedWithCustomError(
      timelock,
      "TimelockPending"
    );
    await evm_increaseTime(72 * 3600);
    await timelock.connect(alice).rotateGuardian();
    expect(await timelock.guardian()).to.equal(bob.address);
    await timelock.connect(bob).pause(); // new guardian can pause
    await expect(timelock.connect(alice).pause()).to.be.revertedWithCustomError(
      timelock,
      "NotGuardian"
    );
  });
});
