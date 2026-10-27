import { expect } from "chai";
import { ethers } from "hardhat";
import {
  asBridge,
  bootstrapV2,
  deployInitializedV2Core,
  deployV2Core,
  INITIAL_SHARES,
  LOCAL_100,
  mintAndBridge,
  SOURCE_100,
} from "./helper/v2";
import { evm_increaseTime } from "./helper";

describe("V2 governance and equity boundaries", () => {
  let core: Awaited<ReturnType<typeof deployV2Core>>;

  beforeEach(async () => {
    core = await deployInitializedV2Core();
  });

  it("rejects zero-vote callers on every qualified-governance path", async () => {
    expect(await core.equity.totalVotes()).to.equal(0);
    await expect(core.equity.checkQualified(core.alice.address, [])).to.be.revertedWithCustomError(
      core.equity,
      "NotQualified"
    );
    await expect(core.savings.proposeChange(21000, [])).to.be.revertedWithCustomError(
      core.equity,
      "NotQualified"
    );
    await expect(core.equity.restructureCapTable([], [])).to.be.revertedWithCustomError(
      core.equity,
      "NotQualified"
    );

    await mintAndBridge(core, core.owner, 10_000n * 10n ** 6n);
    const secondBridge = await (await ethers.getContractFactory("StablecoinBridge")).deploy(
      await core.source.getAddress(),
      await core.token.getAddress(),
      ethers.parseEther("100000")
    );
    const secondAddress = await secondBridge.getAddress();
    await core.token.suggestMinter(
      secondAddress,
      await core.token.MIN_APPLICATION_PERIOD(),
      await core.token.MIN_FEE(),
      "second bridge"
    );
    await expect(core.token.denyMinter(secondAddress, [], "zero votes"))
      .to.be.revertedWithCustomError(core.equity, "NotQualified");

    const collateral = await (await ethers.getContractFactory("TestToken")).deploy(
      "Collateral",
      "COL",
      18
    );
    await collateral.approve(await core.hub.getAddress(), ethers.MaxUint256);
    const args = [
      await collateral.getAddress(),
      ethers.parseEther("4000"),
      ethers.parseEther("4000"),
      ethers.parseEther("10000"),
      3n * 86400n,
      30n * 86400n,
      86400n,
      0,
      ethers.parseEther("1"),
      200000,
    ] as const;
    const positionAddress = await core.hub.openPosition.staticCall(...args);
    await core.hub.openPosition(...args);
    const position = await ethers.getContractAt("Position", positionAddress);
    await expect(position.deny([], "zero votes")).to.be.revertedWithCustomError(
      core.equity,
      "NotQualified"
    );
  });

  it("requires strictly more than two percent of time-weighted votes", async () => {
    const distributor = await (await ethers.getContractFactory("TestShareDistributor")).deploy();
    await mintAndBridge(core, core.owner, SOURCE_100);
    await core.token.transfer(await distributor.getAddress(), LOCAL_100);
    await distributor.split(await core.equity.getAddress(), core.alice.address, core.bob.address);
    await evm_increaseTime(60);

    const aliceVotes = await core.equity.votes(core.alice.address);
    const bobVotes = await core.equity.votes(core.bob.address);
    const totalVotes = await core.equity.totalVotes();
    expect(totalVotes).to.be.greaterThan(0);
    expect(aliceVotes * 10000n).to.equal(200n * totalVotes);
    expect(bobVotes * 10000n).to.be.greaterThan(200n * totalVotes);
    await expect(core.equity.checkQualified(core.alice.address, [])).to.be.revertedWithCustomError(
      core.equity,
      "NotQualified"
    );
    await expect(core.equity.checkQualified(core.bob.address, [])).not.to.be.reverted;
  });

  it("uses 100 as the restructuring boundary and recaps without a zero-vote bypass", async () => {
    await bootstrapV2(core);
    await evm_increaseTime(60);
    await expect(core.equity.restructureCapTable([], [core.owner.address])).to.be.revertedWithoutReason();

    const bridgeSigner = await asBridge(core);
    await core.token.connect(bridgeSigner).burnFrom(await core.equity.getAddress(), ethers.parseEther("1"));
    expect(await core.token.equity()).to.equal(ethers.parseEther("99"));
    await core.equity.restructureCapTable([], [core.owner.address]);
    expect(await core.equity.totalSupply()).to.equal(0);
    expect(await core.equity.balanceOf(core.owner.address)).to.equal(0);

    await mintAndBridge(core, core.owner, 1_000_000n);
    await core.equity.invest(ethers.parseEther("1"), INITIAL_SHARES);
    expect(await core.token.equity()).to.equal(LOCAL_100);
    expect(await core.equity.totalSupply()).to.equal(INITIAL_SHARES);
    expect(await core.equity.balanceOf(core.owner.address)).to.equal(INITIAL_SHARES);
    expect(await core.equity.price()).to.equal(ethers.parseEther("0.3"));
  });

  it("uses cubic share pricing for subsequent investments above 100", async () => {
    await bootstrapV2(core);
    const investment = ethers.parseEther("700");
    const expected = await core.equity.calculateShares(investment);
    expect(expected).to.be.greaterThan(0);
    expect(expected).to.be.lessThan(INITIAL_SHARES);
    await mintAndBridge(core, core.owner, 700n * 10n ** 6n);
    await core.equity.invest(investment, expected);

    const totalShares = await core.equity.totalSupply();
    expect(totalShares).to.equal(INITIAL_SHARES + expected);
    expect(await core.equity.balanceOf(core.owner.address)).to.equal(INITIAL_SHARES + expected);
    expect(await core.token.equity()).to.equal(ethers.parseEther("800"));
    expect(await core.equity.price()).to.equal(
      (3n * ethers.parseEther("800") * ethers.parseEther("1")) / totalShares
    );
  });

  it("preserves pool-share wrapping and unwrapping after the lower bootstrap", async () => {
    await bootstrapV2(core);
    const wrapper = await (await ethers.getContractFactory("OFDPSWrapper")).deploy(
      await core.equity.getAddress()
    );
    await core.equity.approve(await wrapper.getAddress(), INITIAL_SHARES);
    await wrapper.wrap(ethers.parseEther("500"));
    expect(await wrapper.balanceOf(core.owner.address)).to.equal(ethers.parseEther("500"));
    expect(await wrapper.underlying()).to.equal(await core.equity.getAddress());

    await wrapper.withdrawTo(core.alice.address, ethers.parseEther("100"));
    expect(await wrapper.balanceOf(core.owner.address)).to.equal(ethers.parseEther("400"));
    expect(await core.equity.balanceOf(core.alice.address)).to.equal(ethers.parseEther("100"));
  });

  it("keeps later rate changes under qualified share governance with a seven-day delay", async () => {
    await bootstrapV2(core);
    await evm_increaseTime(60);
    await core.savings.proposeChange(21000, []);
    expect(await core.savings.nextRatePPM()).to.equal(21000);
    await expect(core.savings.applyChange()).to.be.revertedWithCustomError(core.savings, "ChangeNotReady");
    await evm_increaseTime(7 * 86400 + 1);
    await core.savings.applyChange();
    expect(await core.savings.currentRatePPM()).to.equal(21000);
  });

  it("caps high-rate savings interest at available equity instead of creating a guaranteed yield", async () => {
    const highRate = await deployInitializedV2Core(204061);
    await bootstrapV2(highRate);
    const principal = ethers.parseEther("100000");
    await mintAndBridge(highRate, highRate.owner, 100_000n * 10n ** 6n);
    await highRate.savings["save(uint192)"](principal);
    await evm_increaseTime(4 * 86400);
    const earlyInterest = await highRate.savings["accruedInterest(address)"](highRate.owner.address);
    expect(earlyInterest).to.be.greaterThan(0);
    expect(earlyInterest).to.be.lessThan(LOCAL_100);

    await evm_increaseTime(3 * 86400);
    expect(await highRate.savings["accruedInterest(address)"](highRate.owner.address)).to.equal(LOCAL_100);
    await highRate.savings.refreshMyBalance();
    const account = await highRate.savings.savings(highRate.owner.address);
    expect(account.saved).to.equal(principal + LOCAL_100);
    expect(await highRate.token.equity()).to.equal(0);
    await highRate.savings.withdraw(highRate.owner.address, account.saved);
    expect(await highRate.token.balanceOf(highRate.owner.address)).to.equal(principal + LOCAL_100);
  });
});
