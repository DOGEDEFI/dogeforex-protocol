import { expect } from "chai";
import "@nomicfoundation/hardhat-chai-matchers";
import { ethers } from "hardhat";
import { AbiCoder, parseUnits } from "ethers";
import type { EIP1193Provider } from "hardhat/types";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deployInitializedV2Core, mintAndBridge } from "./helper/v2";
import { evm_increaseTimeTo } from "./helper";
import { poolTickRange, positionCollateral, selectedCurrencies, sqrtPriceX96, isqrt } from "../scripts/execution/demoMath";
import { TotalFeeGuard } from "../scripts/deployment/v2FeeGuard";

const config = JSON.parse(readFileSync(join(__dirname, "../scripts/execution/demoRollout.config.json"), "utf8"));
const Q96 = 1n << 96n;

describe("Demo rollout configuration and position lifecycle", () => {
  it("limits position and due-mint operations to an approved pilot currency", () => {
    expect(selectedCurrencies(config.allCurrencies, "CHF")).to.deep.equal(["CHF"]);
    expect(selectedCurrencies(config.allCurrencies)).to.deep.equal(config.allCurrencies);
    expect(() => selectedCurrencies(config.allCurrencies, "UNKNOWN")).to.throw("Unknown currency pilot");
  });

  it("computes decimal-correct pool prices in either token order", () => {
    expect(sqrtPriceX96(6, 18, "1", "1")).to.equal(1_000_000n * Q96);
    expect(sqrtPriceX96(18, 6, "1", "1")).to.equal(Q96 / 1000000n);
    expect(sqrtPriceX96(6, 18, "100", "1")).to.equal(10_000_000n * Q96);
    expect(sqrtPriceX96(18, 6, "100", "1")).to.equal(Q96 / 100000n);
    expect(sqrtPriceX96(6, 18, "1", "4")).to.equal(500_000n * Q96);
    expect(sqrtPriceX96(18, 6, "1", "4")).to.equal(Q96 / 2000000n);
    expect(isqrt(0n)).to.equal(0n);
    expect(isqrt(1n)).to.equal(1n);
    expect(isqrt(15n)).to.equal(3n);
    expect(isqrt(16n)).to.equal(4n);
    expect(isqrt(17n)).to.equal(4n);
    for (const token of config.demoTokens) {
      expect(parseUnits(token.poolDemo, 18) * BigInt(token.priceNumerator)).to.equal(parseUnits("1000", 18) * BigInt(token.priceDenominator));
      expect(sqrtPriceX96(6, 18, token.priceNumerator, token.priceDenominator) > 0n).to.equal(true);
      expect(sqrtPriceX96(18, 6, token.priceNumerator, token.priceDenominator) > 0n).to.equal(true);
    }
    const demo02 = config.demoTokens.find((token) => token.symbol === "DEMO02");
    const sourceFirstExpected = isqrt((BigInt(demo02.priceDenominator) * 10n ** 12n << 192n) / BigInt(demo02.priceNumerator));
    expect(sqrtPriceX96(6, 18, demo02.priceDenominator, demo02.priceNumerator)).to.equal(sourceFirstExpected);
    expect(sourceFirstExpected).to.be.greaterThan(sqrtPriceX96(6, 18, demo02.priceNumerator, demo02.priceDenominator));
    expect(() => sqrtPriceX96(6, 18, "0", "1")).to.throw("Pool price must be positive");
  });

  it("rounds configured pool tick bounds to the pool spacing", () => {
    expect(poolTickRange(-887220, 887220, 60n)).to.deep.equal({ tickLower: -887220, tickUpper: 887220 });
    expect(poolTickRange(-51, 51, 60n)).to.deep.equal({ tickLower: -60, tickUpper: 60 });
    expect(poolTickRange(-51, 51, 1n)).to.deep.equal({ tickLower: -51, tickUpper: 51 });
    expect(() => poolTickRange(0, 0, 0n)).to.throw("Invalid tick range");
  });

  it("derives the exact approved collateral ratios", () => {
    const expected = [parseUnits("11000", 18), parseUnits("1500", 18), parseUnits("200", 18)];
    for (const [index, plan] of config.positions.entries()) {
      const result = positionCollateral(plan.price, plan.ratioPercent, config.positionTerms.capLocal);
      expect(result.collateralRaw).to.equal(parseUnits(plan.initialCollateral, 18));
      expect(result.collateralRaw).to.equal(expected[index]);
      expect(result.collateralRaw * result.priceRaw * 100n >= result.capRaw * BigInt(plan.ratioPercent)).to.equal(true);
      expect(config.positionTerms.riskPremiumPPM).to.equal(20000);
      expect(config.positionTerms.reservePPM).to.equal(200000);
    }
    expect(() => positionCollateral("1", 109)).to.throw("between 110% and 200%");
  });

  for (const plan of config.positions) {
    it(`opens and mints ${plan.symbol} only after initialization at ${plan.ratioPercent}%`, async () => {
      const core = await deployInitializedV2Core();
      await mintAndBridge(core, core.owner, 200_000n * 10n ** 6n);
      await core.equity.invest(ethers.parseEther("100"), ethers.parseEther("1000"));
      const collateral = await (await ethers.getContractFactory("TestToken")).deploy(`Demo ${plan.symbol}`, plan.symbol, 18);
      const { priceRaw, capRaw, collateralRaw, minCollateralRaw } = positionCollateral(plan.price, plan.ratioPercent, config.positionTerms.capLocal);
      await collateral.approve(await core.hub.getAddress(), collateralRaw);
      const tx = await core.hub.openPosition(
        await collateral.getAddress(), minCollateralRaw, collateralRaw, capRaw,
        config.positionTerms.initPeriodSeconds, config.positionTerms.durationSeconds,
        config.positionTerms.challengePeriodSeconds, config.positionTerms.riskPremiumPPM,
        priceRaw, config.positionTerms.reservePPM,
      );
      const receipt = await tx.wait();
      const events = await core.hub.queryFilter(core.hub.filters.PositionOpened(core.owner.address), receipt!.blockNumber, receipt!.blockNumber);
      expect(events.length).to.equal(1);
      if (!("args" in events[0])) throw new Error("PositionOpened did not decode");
      const position = await ethers.getContractAt("Position", events[0].args.position);
      expect(await position.minted()).to.equal(0n);
      expect(minCollateralRaw * priceRaw >= ethers.parseEther("3500") * (10n ** 18n)).to.equal(true);
      expect(minCollateralRaw * priceRaw <= capRaw * (10n ** 18n)).to.equal(true);
      expect(await position.riskPremiumPPM()).to.equal(20000n);
      expect(await position.reserveContribution()).to.equal(200000n);
      await expect(position.mint(core.owner.address, capRaw)).to.be.revertedWithCustomError(position, "Hot");
      await evm_increaseTimeTo((await position.cooldown()) + 1n);
      const usable = await position.getUsableMint(capRaw, true);
      expect(usable > 0n).to.equal(true);
      expect(usable < capRaw).to.equal(true);
      const before = await core.token.balanceOf(core.owner.address);
      await (await position.mint(core.owner.address, capRaw)).wait();
      expect(await position.minted()).to.equal(capRaw);
      expect(await position.availableForMinting()).to.equal(0n);
      expect((await collateral.balanceOf(await position.getAddress())) * priceRaw * 100n >= capRaw * BigInt(plan.ratioPercent)).to.equal(true);
      expect((await core.token.balanceOf(core.owner.address)) - before > 0n).to.equal(true);
    });
  }

  it("mints fresh-quoted pool shares for every graduated Equity scenario", async () => {
    expect(Object.keys(config.equityInvestments)).to.deep.equal(config.allCurrencies);
    const core = await deployInitializedV2Core();
    await mintAndBridge(core, core.owner, 200_000n * 10n ** 6n);
    await core.equity.invest(ethers.parseEther("100"), ethers.parseEther("1000"));
    for (const code of config.allCurrencies) {
      const amount = ethers.parseEther(config.equityInvestments[code]);
      expect(amount > 0n).to.equal(true);
      await mintAndBridge(core, core.owner, amount / 10n ** 12n);
      const expectedShares = await core.equity.calculateShares(amount);
      expect(expectedShares > 0n).to.equal(true);
      const beforeCurrency = await core.token.balanceOf(core.owner.address);
      const beforeShares = await core.equity.balanceOf(core.owner.address);
      const beforeTotalShares = await core.equity.totalSupply();
      await (await core.equity.invest(amount, expectedShares)).wait();
      const actualShares = (await core.equity.balanceOf(core.owner.address)) - beforeShares;
      expect(actualShares).to.equal(expectedShares);
      expect(beforeCurrency - (await core.token.balanceOf(core.owner.address))).to.equal(amount);
      expect((await core.equity.totalSupply()) - beforeTotalShares).to.equal(actualShares);
    }
  });

  it("allows only the explicitly authorized demo fee-guard scope", async () => {
    const deployer = ethers.Wallet.createRandom();
    const provider = {
      request: async ({ method }: { method: string }) => method === "eth_getCode"
        ? "0x01"
        : AbiCoder.defaultAbiCoder().encode(["uint256"], [1000]),
    } as unknown as EIP1193Provider;
    const guard = new TotalFeeGuard(provider, { network: "chikyuV2", chainId: 6281971n, deployer: deployer.address, scope: "DEMO_ROLLOUT", stateFile: null, maxL1FeePerByte: parseUnits("0.000497", 18) });
    try {
      const signed = await deployer.signTransaction({ to: deployer.address, value: 0, gasLimit: 21000, gasPrice: 1, chainId: 6281971 });
      const quote = await guard.quoteSerialized(signed);
      expect(guard.maxL1FeePerByte).to.equal(parseUnits("0.000497", 18));
      expect(quote.from).to.equal(deployer.address);
      expect(quote.reservedFee > 0n).to.equal(true);
      const other = new TotalFeeGuard(provider, { network: "chikyuV2", chainId: 6281971n, deployer: deployer.address, scope: "OTHER", stateFile: null });
      await expect(other.quoteSerialized(signed)).to.be.rejectedWith("outside the authorized");
      other.close();
    } finally {
      guard.close();
    }
  });
});
