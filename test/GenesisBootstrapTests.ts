import { expect } from "chai";
import { ethers } from "hardhat";
import {
  bootstrapV2,
  deployInitializedV2Core,
  deployV2Core,
  INITIAL_SHARES,
  LOCAL_100,
  mintAndBridge,
  SOURCE_100,
  asBridge,
} from "./helper/v2";
import { evm_increaseTime } from "./helper";

describe("V2 collateralized genesis bootstrap", () => {
  let core: Awaited<ReturnType<typeof deployV2Core>>;

  beforeEach(async () => {
    core = await deployInitializedV2Core();
  });

  it("uses one six-decimal test asset with deployer-only test minting", async () => {
    expect(await core.source.name()).to.equal("Test USDC");
    expect(await core.source.symbol()).to.equal("tUSDC");
    expect(await core.source.decimals()).to.equal(6);
    expect(await core.source.totalSupply()).to.equal(0);
    await expect(core.source.connect(core.alice).mint(core.alice.address, 1)).to.be.revertedWith(
      "TestUSDC: only deployer"
    );
  });

  it("mints 100 local units against 100 tUSDC and issues exactly 1,000 shares", async () => {
    await bootstrapV2(core);

    expect(await core.source.balanceOf(await core.bridge.getAddress())).to.equal(SOURCE_100);
    expect(await core.source.totalSupply()).to.equal(SOURCE_100);
    expect(await core.bridge.decimalMultiplier()).to.equal(10n ** 12n);
    expect(await core.bridge.minted()).to.equal(LOCAL_100);
    expect(await core.token.totalSupply()).to.equal(LOCAL_100);
    expect(await core.token.balanceOf(await core.equity.getAddress())).to.equal(LOCAL_100);
    expect(await core.token.balanceOf(core.owner.address)).to.equal(0);
    expect(await core.token.minterReserve()).to.equal(0);
    expect(await core.token.equity()).to.equal(LOCAL_100);
    expect(await core.equity.totalSupply()).to.equal(INITIAL_SHARES);
    expect(await core.equity.balanceOf(core.owner.address)).to.equal(INITIAL_SHARES);
    expect(await core.equity.price()).to.equal(ethers.parseEther("0.3"));

    for (const contract of [core.savings, core.positionFactory, core.roller, core.hub, core.bridge]) {
      expect(await core.token.isMinter(await contract.getAddress())).to.be.true;
    }
    expect(await core.token.isMinter(core.owner.address)).to.be.false;
  });

  it("rejects deposits below 100 and unexpected initial share amounts atomically", async () => {
    await mintAndBridge(core, core.owner, SOURCE_100);
    const balance = await core.token.balanceOf(core.owner.address);
    expect(await core.equity.calculateShares(LOCAL_100)).to.equal(INITIAL_SHARES);

    await expect(core.equity.invest(LOCAL_100 - 1n, 0)).to.be.revertedWith("insuf equity");
    expect(await core.token.balanceOf(core.owner.address)).to.equal(balance);
    await expect(core.equity.invest(LOCAL_100, INITIAL_SHARES + 1n)).to.be.revertedWithoutReason();
    expect(await core.token.balanceOf(core.owner.address)).to.equal(balance);

    await core.equity.invest(LOCAL_100, INITIAL_SHARES);
    expect(await core.equity.balanceOf(core.owner.address)).to.equal(INITIAL_SHARES);
  });

  it("keeps initialize deployer-only and closed when either supply is nonzero", async () => {
    const fresh = await deployV2Core();
    await expect(
      fresh.token.connect(fresh.alice).initialize(fresh.alice.address, "malicious")
    ).to.be.revertedWith("OracleFreeDollar: Only deployer can initialize");

    await mintAndBridge(core, core.owner, SOURCE_100);
    await expect(core.token.initialize(core.owner.address, "late")).to.be.revertedWithoutReason();
    await core.equity.invest(LOCAL_100, INITIAL_SHARES);
    await expect(core.token.initialize(core.owner.address, "late")).to.be.revertedWithoutReason();

    const bridgeSigner = await asBridge(core);
    await core.token.connect(bridgeSigner).burnFrom(await core.equity.getAddress(), LOCAL_100);
    expect(await core.token.totalSupply()).to.equal(0);
    expect(await core.equity.totalSupply()).to.equal(INITIAL_SHARES);
    await expect(core.token.initialize(core.owner.address, "late")).to.be.revertedWithoutReason();
  });

  it("has no guardian or privileged admission API", async () => {
    const tokenInterface = new ethers.Interface(core.token.interface.fragments);
    const hubInterface = new ethers.Interface(core.hub.interface.fragments);
    expect(tokenInterface.getFunction("guardian")).to.be.null;
    expect(tokenInterface.getFunction("setGuardian")).to.be.null;
    expect(hubInterface.getFunction("admissionGuardianPaused")).to.be.null;

    await expect(core.token.suggestMinter(core.alice.address, 1, 1, "")).to.be.revertedWithCustomError(
      core.token,
      "PeriodTooShort"
    );
  });

  it("allows ordinary applications and qualified vetoes without an administrator", async () => {
    await bootstrapV2(core);
    await mintAndBridge(core, core.owner, 3000n * 10n ** 6n);
    await core.token.transfer(core.alice.address, ethers.parseEther("2000"));
    const secondBridge = await (await ethers.getContractFactory("StablecoinBridge")).deploy(
      await core.source.getAddress(),
      await core.token.getAddress(),
      ethers.parseEther("100000")
    );
    const period = await core.token.MIN_APPLICATION_PERIOD();
    const fee = await core.token.MIN_FEE();
    const address = await secondBridge.getAddress();

    await core.token.connect(core.alice).suggestMinter(address, period, fee, "second bridge");
    expect(await core.token.isMinter(address)).to.be.false;
    await expect(core.token.connect(core.alice).denyMinter(address, [], "not qualified"))
      .to.be.revertedWithCustomError(core.equity, "NotQualified");
    await expect(core.token.denyMinter(address, [], "veto")).to.emit(core.token, "MinterDenied");
    expect(await core.token.isMinter(address)).to.be.false;

    await evm_increaseTime(Number(period) + 1);
    expect(await core.token.isMinter(address)).to.be.false;
  });
});
