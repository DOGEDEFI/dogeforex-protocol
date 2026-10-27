import { expect } from "chai";
import { ethers } from "hardhat";
import { bootstrapV2, deployInitializedV2Core, deployV2Core, mintAndBridge } from "./helper/v2";
import { evm_increaseTime } from "./helper";
import { TestToken } from "../typechain";

describe("V2 position initialization and admission", () => {
  let core: Awaited<ReturnType<typeof deployV2Core>>;
  let collateral: TestToken;

  beforeEach(async () => {
    core = await deployInitializedV2Core();
    await bootstrapV2(core);
    await mintAndBridge(core, core.owner, 10_000n * 10n ** 6n);
    collateral = await (await ethers.getContractFactory("TestToken")).deploy("Collateral", "COL", 18);
    await collateral.approve(await core.hub.getAddress(), ethers.MaxUint256);
  });

  const open = async (initPeriod: bigint) => {
    const args = [
      await collateral.getAddress(),
      ethers.parseEther("4000"),
      ethers.parseEther("4000"),
      ethers.parseEther("10000"),
      initPeriod,
      30n * 86400n,
      86400n,
      0,
      ethers.parseEther("1"),
      200000,
    ] as const;
    const address = await core.hub.openPosition.staticCall(...args);
    await core.hub.openPosition(...args);
    return await ethers.getContractAt("Position", address);
  };

  it("rejects less than three days and allows minting only after the exact window", async () => {
    await expect(open(3n * 86400n - 1n)).to.be.revertedWithoutReason();
    const position = await open(3n * 86400n);
    const block = await ethers.provider.getBlock("latest");
    expect(await position.start()).to.equal(BigInt(block!.timestamp) + 3n * 86400n);
    await expect(position.mint(core.owner.address, ethers.parseEther("100"))).to.be.revertedWithCustomError(
      position,
      "Hot"
    );

    await evm_increaseTime(3 * 86400);
    await position.mint(core.owner.address, ethers.parseEther("100"));
    expect(await position.minted()).to.equal(ethers.parseEther("100"));
    expect(await core.token.minterReserve()).to.equal(ethers.parseEther("20"));

    const expiration = await position.expiration();
    const clone = core.hub["clone(address,uint256,uint256,uint40)"];
    const childAddress = await clone.staticCall(
      await position.getAddress(),
      ethers.parseEther("4000"),
      ethers.parseEther("100"),
      expiration
    );
    await clone(
      await position.getAddress(),
      ethers.parseEther("4000"),
      ethers.parseEther("100"),
      expiration
    );
    const child = await ethers.getContractAt("Position", childAddress);
    expect(await child.original()).to.equal(await position.getAddress());
    expect(await child.owner()).to.equal(core.owner.address);
    expect(await child.minted()).to.equal(ethers.parseEther("100"));
    expect(await core.token.minterReserve()).to.equal(ethers.parseEther("40"));
  });

  it("lets qualified holders deny during initialization but never an unqualified caller", async () => {
    const position = await open(3n * 86400n);
    await expect(position.connect(core.alice).deny([], "unqualified")).to.be.revertedWithCustomError(
      core.equity,
      "NotQualified"
    );
    await expect(position.deny([], "denied")).to.emit(position, "PositionDenied");
    expect(await position.isClosed()).to.be.true;
    await evm_increaseTime(3 * 86400);
    await expect(position.mint(core.owner.address, 1)).to.be.revertedWithCustomError(position, "Closed");
  });

  it("applies the high-rate fixture plus risk premium to upfront position fees", async () => {
    const highRate = await deployInitializedV2Core(204061);
    await bootstrapV2(highRate);
    await mintAndBridge(highRate, highRate.owner, 10_000n * 10n ** 6n);
    const highRateCollateral = await (await ethers.getContractFactory("TestToken")).deploy(
      "High Rate Collateral",
      "HRC",
      18
    );
    await highRateCollateral.approve(await highRate.hub.getAddress(), ethers.MaxUint256);
    const args = [
      await highRateCollateral.getAddress(),
      ethers.parseEther("4000"),
      ethers.parseEther("4000"),
      ethers.parseEther("10000"),
      3n * 86400n,
      365n * 86400n,
      86400n,
      20000,
      ethers.parseEther("1"),
      200000,
    ] as const;
    const address = await highRate.hub.openPosition.staticCall(...args);
    await highRate.hub.openPosition(...args);
    const position = await ethers.getContractAt("Position", address);
    expect(await position.annualInterestPPM()).to.equal(224061);
    await evm_increaseTime(3 * 86400);
    const fee = await position.calculateCurrentFee();
    expect(fee).to.be.greaterThan(220000);
    expect(fee).to.be.lessThanOrEqual(224061);

    const balanceBefore = await highRate.token.balanceOf(highRate.owner.address);
    await position.mint(highRate.owner.address, ethers.parseEther("100"));
    const received = (await highRate.token.balanceOf(highRate.owner.address)) - balanceBefore;
    expect(received).to.be.greaterThan(ethers.parseEther("55"));
    expect(received).to.be.lessThan(ethers.parseEther("60"));
    expect(await highRate.token.minterReserve()).to.equal(ethers.parseEther("20"));
  });

  it("accepts a longer initialization period without changing the three-day floor", async () => {
    const position = await open(5n * 86400n);
    const block = await ethers.provider.getBlock("latest");
    expect(await position.start()).to.equal(BigInt(block!.timestamp) + 5n * 86400n);
    await evm_increaseTime(3 * 86400);
    await expect(position.mint(core.owner.address, 1)).to.be.revertedWithCustomError(position, "Hot");
  });
});
