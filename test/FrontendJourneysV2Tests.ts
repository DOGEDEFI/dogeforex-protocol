import { expect } from "chai";
import { ethers } from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";
import type { TransactionReceipt } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { V2Action, V2Operation } from "../../dogeforex-ui/imf-v2/src/actions";
import { asBridge, deployInitializedV2Core, deployV2Core, mintAndBridge } from "./helper/v2";
import { evm_increaseTime, evm_increaseTimeTo } from "./helper";
import type { Position, TestToken } from "../typechain";

type AppActions = typeof import("../../dogeforex-ui/imf-v2/src/actions");

function loadAppActions(): AppActions {
  const filename = path.resolve(__dirname, "../../dogeforex-ui/imf-v2/src/actions.ts");
  const source = fs.readFileSync(filename, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText;
  const actionModule = { exports: {} };
  new Function("require", "module", "exports", output)(createRequire(filename), actionModule, actionModule.exports);
  return actionModule.exports as AppActions;
}

const {
  V2_ACTION_METADATA,
  decodeChallengeStarted,
  decodePositionOpened,
  decodeV2Receipt,
  encodeV2Action,
} = loadAppActions();

const E18 = ethers.parseEther("1");
const DAY = 86_400n;
const executed = new Set<V2Operation>();

async function send(signer: HardhatEthersSigner, action: V2Action): Promise<TransactionReceipt> {
  const descriptor = encodeV2Action(action);
  const response = await signer.sendTransaction({ to: descriptor.to, data: descriptor.data });
  const receipt = await response.wait();
  expect(receipt).not.to.equal(null);
  expect(receipt!.status).to.equal(1);
  executed.add(action.operation);
  return receipt!;
}

describe("Frontend V2 action journeys on local EVM", () => {
  let core: Awaited<ReturnType<typeof deployV2Core>>;
  let collateral: TestToken;

  beforeEach(async () => {
    core = await deployInitializedV2Core();
    await mintAndBridge(core, core.owner, 200_000n * 10n ** 6n);
    await send(core.owner, {
      operation: "equity.invest",
      target: await core.equity.getAddress(),
      args: { amount: ethers.parseEther("100"), expectedShares: ethers.parseEther("1000") },
    });
    collateral = await (await ethers.getContractFactory("TestToken")).deploy("Collateral", "COL", 18);
    await collateral.transfer(core.alice.address, ethers.parseEther("20000"));
    await collateral.transfer(core.bob.address, ethers.parseEther("20000"));
    await core.token.transfer(core.alice.address, ethers.parseEther("20000"));
    await core.token.transfer(core.bob.address, ethers.parseEther("20000"));
  });

  after(() => {
    expect([...executed].sort()).to.deep.equal(Object.keys(V2_ACTION_METADATA).sort());
  });

  async function openPosition(
    signer: HardhatEthersSigner = core.owner,
    token: TestToken = collateral,
    duration = 60n * DAY,
  ): Promise<Position> {
    await send(signer, {
      operation: "erc20.approve",
      target: await token.getAddress(),
      args: { spender: await core.hub.getAddress(), amount: ethers.MaxUint256 },
    });
    const receipt = await send(signer, {
      operation: "hub.openPosition",
      target: await core.hub.getAddress(),
      args: {
        collateral: await token.getAddress(),
        minCollateral: ethers.parseEther("4000"),
        initialCollateral: ethers.parseEther("4000"),
        mintingMaximum: ethers.parseEther("100000"),
        initPeriodSeconds: 3n * DAY,
        expirationSeconds: duration,
        challengeSeconds: DAY,
        riskPremiumPPM: 0n,
        liquidationPrice: E18,
        reservePPM: 200_000n,
      },
    });
    const opened = decodePositionOpened(receipt, await core.hub.getAddress());
    expect(opened.args.owner).to.equal(signer.address);
    return await ethers.getContractAt("Position", opened.args.position as string, signer);
  }

  it("executes bridge deposits, redemptions, credits, and permissionless payouts", async () => {
    await core.source.mint(core.owner.address, 100n * 10n ** 6n);
    await send(core.owner, {
      operation: "erc20.approve",
      target: await core.source.getAddress(),
      args: { spender: await core.bridge.getAddress(), amount: 100n * 10n ** 6n },
    });
    const mintReceipt = await send(core.owner, {
      operation: "bridge.mintTo",
      target: await core.bridge.getAddress(),
      args: { target: core.alice.address, amount: 100n * 10n ** 6n },
    });
    expect(decodeV2Receipt(mintReceipt).some((event) => event.name === "Mint")).to.equal(true);
    expect(await core.token.balanceOf(core.alice.address)).to.equal(ethers.parseEther("20100"));

    const bobSourceBefore = await core.source.balanceOf(core.bob.address);
    await send(core.alice, {
      operation: "bridge.burnAndSend",
      target: await core.bridge.getAddress(),
      args: { target: core.bob.address, amount: ethers.parseEther("20") },
    });
    expect((await core.source.balanceOf(core.bob.address)) - bobSourceBefore).to.equal(20n * 10n ** 6n);

    await send(core.alice, {
      operation: "bridge.burnAndCredit",
      target: await core.bridge.getAddress(),
      args: { target: core.bob.address, amount: ethers.parseEther("30") },
    });
    expect(await core.bridge.credits(core.bob.address)).to.equal(30n * 10n ** 6n);
    await send(core.owner, {
      operation: "bridge.payoutCredit",
      target: await core.bridge.getAddress(),
      args: { target: core.bob.address },
    });
    expect(await core.bridge.credits(core.bob.address)).to.equal(0n);
    expect((await core.source.balanceOf(core.bob.address)) - bobSourceBefore).to.equal(50n * 10n ** 6n);
  });

  it("opens, mints, clones, adjusts, repays, withdraws, and transfers ownership", async () => {
    const position = await openPosition();
    await evm_increaseTimeTo((await position.start()) + 1n);
    await send(core.owner, {
      operation: "position.mint",
      target: await position.getAddress(),
      args: { target: core.owner.address, amount: ethers.parseEther("1000") },
    });
    expect(await position.minted()).to.equal(ethers.parseEther("1000"));

    await send(core.owner, {
      operation: "erc20.approve",
      target: await collateral.getAddress(),
      args: { spender: await position.getAddress(), amount: ethers.parseEther("100") },
    });
    const collateralBefore = await collateral.balanceOf(await position.getAddress());
    const adjustReceipt = await send(core.owner, {
      operation: "position.adjust",
      target: await position.getAddress(),
      args: {
        newMinted: ethers.parseEther("1100"),
        newCollateral: collateralBefore + ethers.parseEther("100"),
        newPrice: await position.price(),
      },
    });
    expect(await position.minted()).to.equal(ethers.parseEther("1100"));
    expect(await collateral.balanceOf(await position.getAddress())).to.equal(
      collateralBefore + ethers.parseEther("100"),
    );
    expect(decodeV2Receipt(adjustReceipt).some((event) => event.name === "MintingUpdate")).to.equal(true);

    await send(core.owner, {
      operation: "position.adjustPrice",
      target: await position.getAddress(),
      args: { newPrice: ethers.parseEther("0.9") },
    });
    expect(await position.price()).to.equal(ethers.parseEther("0.9"));

    await core.token.transfer(await position.getAddress(), ethers.parseEther("5"));
    const bobTokenBefore = await core.token.balanceOf(core.bob.address);
    await send(core.owner, {
      operation: "position.withdraw",
      target: await position.getAddress(),
      args: { token: await core.token.getAddress(), target: core.bob.address, amount: ethers.parseEther("5") },
    });
    expect((await core.token.balanceOf(core.bob.address)) - bobTokenBefore).to.equal(ethers.parseEther("5"));

    const cloneReceipt = await send(core.owner, {
      operation: "hub.clone",
      target: await core.hub.getAddress(),
      args: {
        owner: core.alice.address,
        parent: await position.getAddress(),
        initialCollateral: ethers.parseEther("4000"),
        initialMint: ethers.parseEther("500"),
        expiration: await position.expiration(),
      },
    });
    const childAddress = decodePositionOpened(cloneReceipt, await core.hub.getAddress()).args.position as string;
    const child = await ethers.getContractAt("Position", childAddress, core.alice);
    expect(await child.owner()).to.equal(core.alice.address);
    expect(await child.minted()).to.equal(ethers.parseEther("500"));

    await send(core.alice, {
      operation: "position.repay",
      target: childAddress,
      args: { amount: ethers.parseEther("100") },
    });
    expect(await child.minted()).to.be.lessThan(ethers.parseEther("500"));
    expect(await child.minted()).to.be.greaterThan(0n);
    const fullRepayment = await core.roller.findRepaymentAmount(childAddress);
    await send(core.alice, {
      operation: "position.repay",
      target: childAddress,
      args: { amount: fullRepayment },
    });
    expect(await child.minted()).to.equal(0n);

    const bobCollateralBefore = await collateral.balanceOf(core.bob.address);
    await send(core.alice, {
      operation: "position.withdrawCollateral",
      target: childAddress,
      args: { target: core.bob.address, amount: ethers.parseEther("4000") },
    });
    expect((await collateral.balanceOf(core.bob.address)) - bobCollateralBefore).to.equal(
      ethers.parseEther("4000"),
    );
    expect(await child.isClosed()).to.equal(true);

    await send(core.owner, {
      operation: "position.transferOwnership",
      target: await position.getAddress(),
      args: { newOwner: core.bob.address },
    });
    expect(await position.owner()).to.equal(core.bob.address);
  });

  it("decodes and executes challenge aversion, auction, postponed return, and withdrawal", async () => {
    const position = await openPosition();
    await evm_increaseTimeTo((await position.start()) + 1n);
    await send(core.owner, {
      operation: "position.mint",
      target: await position.getAddress(),
      args: { target: core.owner.address, amount: ethers.parseEther("1000") },
    });
    await send(core.alice, {
      operation: "erc20.approve",
      target: await collateral.getAddress(),
      args: { spender: await core.hub.getAddress(), amount: ethers.parseEther("4000") },
    });
    const challengeReceipt = await send(core.alice, {
      operation: "hub.challenge",
      target: await core.hub.getAddress(),
      args: {
        position: await position.getAddress(),
        collateralAmount: ethers.parseEther("4000"),
        minimumPrice: E18,
      },
    });
    const started = decodeChallengeStarted(challengeReceipt, await core.hub.getAddress());
    expect(started.index).to.equal(0n);
    expect(started.args.position).to.equal(await position.getAddress());
    expect(await position.challengedAmount()).to.equal(ethers.parseEther("4000"));

    const bobCollateralBefore = await collateral.balanceOf(core.bob.address);
    const avertedReceipt = await send(core.bob, {
      operation: "hub.bid",
      target: await core.hub.getAddress(),
      args: { challengeNumber: started.index!, size: ethers.parseEther("1000"), postponeCollateralReturn: false },
    });
    expect(decodeV2Receipt(avertedReceipt, { mintingHub: await core.hub.getAddress() }).some(
      (event) => event.name === "ChallengeAverted" && event.args.number === 0n,
    )).to.equal(true);
    expect((await collateral.balanceOf(core.bob.address)) - bobCollateralBefore).to.equal(
      ethers.parseEther("1000"),
    );
    expect(await position.challengedAmount()).to.equal(ethers.parseEther("3000"));

    await evm_increaseTime(DAY + 1n);
    const auctionReceipt = await send(core.bob, {
      operation: "hub.bid",
      target: await core.hub.getAddress(),
      args: { challengeNumber: 0n, size: ethers.parseEther("1000"), postponeCollateralReturn: true },
    });
    const auctionEvents = decodeV2Receipt(auctionReceipt, { mintingHub: await core.hub.getAddress() });
    expect(auctionEvents.some((event) => event.name === "ChallengeSucceeded")).to.equal(true);
    expect(auctionEvents.some((event) => event.name === "PostPonedReturn")).to.equal(true);
    expect(await core.hub.pendingReturns(await collateral.getAddress(), core.alice.address)).to.equal(
      ethers.parseEther("1000"),
    );

    const aliceCollateralBefore = await collateral.balanceOf(core.alice.address);
    await send(core.alice, {
      operation: "hub.returnPostponedCollateral",
      target: await core.hub.getAddress(),
      args: { collateral: await collateral.getAddress(), target: core.alice.address },
    });
    expect((await collateral.balanceOf(core.alice.address)) - aliceCollateralBefore).to.equal(
      ethers.parseEther("1000"),
    );
    expect(await core.hub.pendingReturns(await collateral.getAddress(), core.alice.address)).to.equal(0n);
  });

  it("buys expired collateral and proves debt and collateral are cleared", async () => {
    const position = await openPosition();
    await evm_increaseTimeTo((await position.start()) + 1n);
    await send(core.owner, {
      operation: "position.mint",
      target: await position.getAddress(),
      args: { target: core.owner.address, amount: ethers.parseEther("1000") },
    });
    await evm_increaseTimeTo((await position.expiration()) + 2n * (await position.challengePeriod()) + 1n);
    expect(await core.hub.expiredPurchasePrice(await position.getAddress())).to.equal(0n);
    const bobCollateralBefore = await collateral.balanceOf(core.bob.address);
    const receipt = await send(core.bob, {
      operation: "hub.buyExpiredCollateral",
      target: await core.hub.getAddress(),
      args: { position: await position.getAddress(), upToAmount: ethers.parseEther("4000") },
    });
    expect(decodeV2Receipt(receipt).some((event) => event.name === "ForcedSale")).to.equal(true);
    expect((await collateral.balanceOf(core.bob.address)) - bobCollateralBefore).to.equal(
      ethers.parseEther("4000"),
    );
    expect(await position.minted()).to.equal(0n);
    expect(await position.isClosed()).to.equal(true);
  });

  it("executes both savings overloads, adjustment, interest refresh, withdrawal, and rate governance", async () => {
    const savingsAddress = await core.savings.getAddress();
    await send(core.owner, {
      operation: "savings.save",
      target: savingsAddress,
      args: { amount: ethers.parseEther("100") },
    });
    expect((await core.savings.savings(core.owner.address)).saved).to.equal(ethers.parseEther("100"));

    await send(core.owner, {
      operation: "savings.saveFor",
      target: savingsAddress,
      args: { owner: core.alice.address, amount: ethers.parseEther("25") },
    });
    expect((await core.savings.savings(core.alice.address)).saved).to.equal(ethers.parseEther("25"));

    await send(core.owner, {
      operation: "savings.adjust",
      target: savingsAddress,
      args: { targetAmount: ethers.parseEther("150") },
    });
    expect((await core.savings.savings(core.owner.address)).saved).to.equal(ethers.parseEther("150"));

    await evm_increaseTime(4n * DAY);
    await send(core.owner, { operation: "savings.refreshMyBalance", target: savingsAddress, args: {} });
    expect((await core.savings.savings(core.owner.address)).saved).to.be.greaterThan(ethers.parseEther("150"));
    await send(core.owner, {
      operation: "savings.refreshBalance",
      target: savingsAddress,
      args: { owner: core.owner.address },
    });
    expect((await core.savings.savings(core.owner.address)).ticks).to.equal(await core.savings.currentTicks());

    const savedBeforeWithdrawal = (await core.savings.savings(core.owner.address)).saved;
    const bobBalanceBefore = await core.token.balanceOf(core.bob.address);
    const withdrawalReceipt = await send(core.owner, {
      operation: "savings.withdraw",
      target: savingsAddress,
      args: { target: core.bob.address, amount: ethers.parseEther("50") },
    });
    expect(decodeV2Receipt(withdrawalReceipt).some((event) => event.name === "Withdrawn")).to.equal(true);
    expect((await core.savings.savings(core.owner.address)).saved).to.be.greaterThan(
      savedBeforeWithdrawal - ethers.parseEther("50"),
    );
    expect((await core.savings.savings(core.owner.address)).saved).to.be.lessThan(
      savedBeforeWithdrawal - ethers.parseEther("50") + ethers.parseEther("0.000001"),
    );
    expect((await core.token.balanceOf(core.bob.address)) - bobBalanceBefore).to.equal(ethers.parseEther("50"));

    await send(core.owner, {
      operation: "savings.adjust",
      target: savingsAddress,
      args: { targetAmount: ethers.parseEther("100") },
    });
    expect((await core.savings.savings(core.owner.address)).saved).to.equal(ethers.parseEther("100"));

    const proposalReceipt = await send(core.owner, {
      operation: "savings.proposeChange",
      target: savingsAddress,
      args: { newRatePPM: 60_000n, helpers: [] },
    });
    expect(decodeV2Receipt(proposalReceipt).some((event) => event.name === "RateProposed")).to.equal(true);
    expect(await core.savings.nextRatePPM()).to.equal(60_000n);
    await evm_increaseTime(7n * DAY + 1n);
    await send(core.owner, { operation: "savings.applyChange", target: savingsAddress, args: {} });
    expect(await core.savings.currentRatePPM()).to.equal(60_000n);
  });

  it("delegates votes, redeems expected proceeds, and destroys target voting power", async () => {
    await mintAndBridge(core, core.bob, 100n * 10n ** 6n);
    await send(core.bob, {
      operation: "equity.invest",
      target: await core.equity.getAddress(),
      args: { amount: ethers.parseEther("100"), expectedShares: 0n },
    });
    await send(core.bob, {
      operation: "equity.delegateVoteTo",
      target: await core.equity.getAddress(),
      args: { delegate: core.alice.address },
    });
    await send(core.alice, {
      operation: "equity.delegateVoteTo",
      target: await core.equity.getAddress(),
      args: { delegate: core.owner.address },
    });
    expect(await core.equity.delegates(core.bob.address)).to.equal(core.alice.address);
    expect(await core.equity.delegates(core.alice.address)).to.equal(core.owner.address);
    await evm_increaseTime(60n);
    const helpers = [core.bob.address, core.alice.address].sort((left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase()),
    );
    expect(await core.equity.votesDelegated(core.owner.address, helpers)).to.be.greaterThan(
      await core.equity.votes(core.owner.address),
    );

    await evm_increaseTime(90n * DAY + 60n);
    const proceeds = await core.equity.calculateProceeds(E18);
    const aliceBalanceBefore = await core.token.balanceOf(core.alice.address);
    const redeemReceipt = await send(core.owner, {
      operation: "equity.redeemExpected",
      target: await core.equity.getAddress(),
      args: { target: core.alice.address, shares: E18, expectedProceeds: proceeds },
    });
    expect(decodeV2Receipt(redeemReceipt).some((event) => event.name === "Trade")).to.equal(true);
    expect((await core.token.balanceOf(core.alice.address)) - aliceBalanceBefore).to.equal(proceeds);

    const bobVotes = await core.equity.votes(core.bob.address);
    const bobShares = await core.equity.balanceOf(core.bob.address);
    await send(core.owner, {
      operation: "equity.kamikaze",
      target: await core.equity.getAddress(),
      args: { targets: [core.bob.address], votesToDestroy: bobVotes + bobShares * (1n << 20n) },
    });
    expect(await core.equity.votes(core.bob.address)).to.equal(0n);
  });

  it("suggests and vetoes a minter and denies a new position through qualified governance", async () => {
    await evm_increaseTime(60n);
    const applicationPeriod = await core.token.MIN_APPLICATION_PERIOD();
    const applicationFee = await core.token.MIN_FEE();
    await send(core.owner, {
      operation: "token.suggestMinter",
      target: await core.token.getAddress(),
      args: { minter: core.bob.address, applicationPeriod, applicationFee, message: "local minter" },
    });
    expect(await core.token.minters(core.bob.address)).to.be.greaterThan(0n);
    await send(core.owner, {
      operation: "token.denyMinter",
      target: await core.token.getAddress(),
      args: { minter: core.bob.address, helpers: [], message: "local veto" },
    });
    expect(await core.token.minters(core.bob.address)).to.equal(0n);

    const position = await openPosition();
    await send(core.owner, {
      operation: "position.deny",
      target: await position.getAddress(),
      args: { helpers: [], message: "local position veto" },
    });
    expect(await position.isClosed()).to.equal(true);
  });

  it("restructures an undercapitalized cap table", async () => {
    await evm_increaseTime(60n);
    const bridgeSigner = await asBridge(core);
    await core.token.connect(bridgeSigner).burnFrom(await core.equity.getAddress(), E18);
    expect(await core.token.equity()).to.equal(ethers.parseEther("99"));
    await send(core.owner, {
      operation: "equity.restructureCapTable",
      target: await core.equity.getAddress(),
      args: { helpers: [], addressesToWipe: [core.owner.address] },
    });
    expect(await core.equity.totalSupply()).to.equal(0n);
    expect(await core.equity.balanceOf(core.owner.address)).to.equal(0n);
  });

  it("rolls fully, rolls with custom expiration, and executes a manual roll", async () => {
    const first = await openPosition(core.owner, collateral, 120n * DAY);
    const second = await openPosition(core.owner, collateral, 120n * DAY);
    await evm_increaseTimeTo((await second.start()) + 1n);
    await send(core.owner, {
      operation: "position.mint",
      target: await first.getAddress(),
      args: { target: core.owner.address, amount: ethers.parseEther("1000") },
    });
    await send(core.owner, {
      operation: "erc20.approve",
      target: await collateral.getAddress(),
      args: { spender: await core.roller.getAddress(), amount: ethers.parseEther("4000") },
    });
    await send(core.owner, {
      operation: "roller.rollFully",
      target: await core.roller.getAddress(),
      args: { source: await first.getAddress(), targetPosition: await second.getAddress() },
    });
    expect(await first.minted()).to.equal(0n);
    expect(await second.minted()).to.be.greaterThan(ethers.parseEther("1000"));
    expect(await collateral.balanceOf(await first.getAddress())).to.equal(0n);

    const third = await openPosition(core.owner, collateral, 120n * DAY);
    await evm_increaseTimeTo((await third.start()) + 1n);
    await send(core.owner, {
      operation: "position.mint",
      target: await second.getAddress(),
      args: { target: core.owner.address, amount: ethers.parseEther("3000") },
    });
    const customExpiration = (await third.expiration()) - 60n;
    await send(core.owner, {
      operation: "erc20.approve",
      target: await collateral.getAddress(),
      args: { spender: await core.roller.getAddress(), amount: ethers.parseEther("5000") },
    });
    const customReceipt = await send(core.owner, {
      operation: "roller.rollFullyWithExpiration",
      target: await core.roller.getAddress(),
      args: {
        source: await second.getAddress(),
        targetPosition: await third.getAddress(),
        expiration: customExpiration,
      },
    });
    const customEvents = decodeV2Receipt(customReceipt, { mintingHub: await core.hub.getAddress() });
    const roll = customEvents.find((event) => event.name === "Roll");
    expect(roll).not.to.equal(undefined);
    const customPosition = await ethers.getContractAt("Position", roll!.args.target as string);
    expect(await second.minted()).to.equal(0n);
    expect(await customPosition.expiration()).to.equal(customExpiration);
    expect(await customPosition.owner()).to.equal(core.owner.address);
    expect(await customPosition.minted()).to.be.greaterThan(0n);

    const fourth = await openPosition(core.owner, collateral, 120n * DAY);
    const fifth = await openPosition(core.owner, collateral, 120n * DAY);
    await evm_increaseTimeTo((await fifth.start()) + 1n);
    await send(core.owner, {
      operation: "position.mint",
      target: await fourth.getAddress(),
      args: { target: core.owner.address, amount: ethers.parseEther("1000") },
    });
    const repay = await core.roller.findRepaymentAmount(await fourth.getAddress());
    const mint = await fifth.getMintAmount(repay);
    const collateralDeposit = mint;
    await send(core.owner, {
      operation: "erc20.approve",
      target: await collateral.getAddress(),
      args: { spender: await core.roller.getAddress(), amount: collateralDeposit },
    });
    const fifthCollateralBefore = await collateral.balanceOf(await fifth.getAddress());
    await send(core.owner, {
      operation: "roller.roll",
      target: await core.roller.getAddress(),
      args: {
        source: await fourth.getAddress(),
        repay,
        collateralWithdraw: ethers.parseEther("1000"),
        targetPosition: await fifth.getAddress(),
        mint,
        collateralDeposit,
        expiration: await fifth.expiration(),
      },
    });
    expect(await fourth.minted()).to.equal(0n);
    expect(await fifth.minted()).to.equal(mint);
    expect(await collateral.balanceOf(await fourth.getAddress())).to.equal(ethers.parseEther("3000"));
    expect(await collateral.balanceOf(await fifth.getAddress())).to.equal(fifthCollateralBefore + collateralDeposit);
  });
});
