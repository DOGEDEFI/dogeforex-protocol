import { expect } from "chai";
import { loadInstances, validateInstances } from "../scripts/deployment/instanceConfig";
import {
  IMPLEMENTATION_REVIEW_STATUS,
  leadrateFromNormalized,
  loadAndValidateRateManifest,
  PRODUCTION_REVIEW_STATUS,
} from "../scripts/deployment/rateConfig";
import { resolveNetworkConfig } from "../scripts/deployment/networkConfig";

const EXPECTED_RATES: Record<string, bigint> = {
  USD: 59400n,
  EUR: 44113n,
  JPY: 31600n,
  GBP: 60132n,
  AUD: 64500n,
  CNY: 26800n,
  BRL: 143569n,
  PKR: 139999n,
  BDT: 102400n,
  INR: 79891n,
  NGN: 204061n,
  CHF: 19950n,
};

describe("V2 initial-rate and network configuration", () => {
  it("validates all 12 instances against their dated evidence", () => {
    const instances = loadInstances();
    const manifest = validateInstances(instances);
    expect(manifest.reviewStatus).to.equal(IMPLEMENTATION_REVIEW_STATUS);
    expect(manifest.rates).to.have.length(12);
    for (const evidence of manifest.rates) {
      expect(evidence.leadratePPM).to.equal(Number(EXPECTED_RATES[evidence.code]));
      expect(
        leadrateFromNormalized(evidence.normalizedAnnualYieldPercent, evidence.spreadPPM, evidence.code)
      ).to.equal(EXPECTED_RATES[evidence.code]);
      expect(evidence.observationDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
      expect(evidence.retrievalDate).to.match(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("recomputes continuous, discount, and direct-yield examples exactly", () => {
    expect(leadrateFromNormalized("2.9113071855", 15000, "EUR")).to.equal(44113n);
    expect(leadrateFromNormalized("4.5131677860", 15000, "GBP")).to.equal(60132n);
    expect(leadrateFromNormalized("18.9060642093", 15000, "NGN")).to.equal(204061n);
    expect(leadrateFromNormalized("4.4400", 15000, "USD")).to.equal(59400n);
    expect(leadrateFromNormalized("1.6600", 15000, "JPY")).to.equal(31600n);
    expect(leadrateFromNormalized("1.1800", 15000, "CNY")).to.equal(26800n);
    expect(leadrateFromNormalized("12.8569", 15000, "BRL")).to.equal(143569n);
    expect(leadrateFromNormalized("12.4999", 15000, "PKR")).to.equal(139999n);
    expect(leadrateFromNormalized("8.7400", 15000, "BDT")).to.equal(102400n);
    expect(leadrateFromNormalized("6.4891", 15000, "INR")).to.equal(79891n);
    expect(leadrateFromNormalized("0.4950", 15000, "CHF")).to.equal(19950n);
  });

  it("rounds half up and rejects invalid, negative, excessive-precision, and overflowing inputs", () => {
    expect(leadrateFromNormalized("0.00005", 15000, "half-up")).to.equal(15001n);
    expect(leadrateFromNormalized("0.000049999999999999", 15000, "below-half")).to.equal(15000n);
    expect(leadrateFromNormalized("1676.2215", 15000, "max")).to.equal(16_777_215n);
    expect(() => leadrateFromNormalized("1676.2216", 15000, "overflow")).to.throw("refusing to clamp");
    expect(() => leadrateFromNormalized("1677", 15000, "overflow")).to.throw("refusing to clamp");
    expect(() => leadrateFromNormalized("-0.1", 15000, "negative")).to.throw("nonnegative decimal string");
    expect(() => leadrateFromNormalized("0.1", -1, "negative-spread")).to.throw("nonnegative safe integer");
    expect(() => leadrateFromNormalized("0.1234567890123456789", 15000, "precision")).to.throw(
      "at most 18 fractional digits"
    );
  });

  it("rejects missing, duplicate, and mismatched instance configuration", () => {
    const instances = loadInstances();
    expect(() => validateInstances(instances.slice(1))).to.throw("Exactly 12");
    expect(() => validateInstances([...instances, instances[0]])).to.throw();
    const wrongRate = instances.map((instance) =>
      instance.code === "USD" ? { ...instance, leadratePPM: instance.leadratePPM + 1 } : instance
    );
    expect(() => validateInstances(wrongRate)).to.throw("does not match evidence calculation");
    const emptyName = instances.map((instance, index) => (index === 0 ? { ...instance, tokenName: "" } : instance));
    expect(() => validateInstances(emptyName)).to.throw("tokenName must be non-empty");
  });

  it("permits test sources only on explicit test networks and never falls back for unknown networks", () => {
    const instances = loadInstances();
    for (const [name, chainId] of [["hardhat", 31337n], ["chikyuV2", 6281971n]] as const) {
      const network = resolveNetworkConfig(name, chainId, instances, IMPLEMENTATION_REVIEW_STATUS);
      expect(network.isTest).to.be.true;
      expect(network.source.decimals).to.equal(6);
      expect(network.bridgeLimits.USD).to.equal(10n ** 24n);
    }
    expect(() => resolveNetworkConfig("hardhat", 1n, instances, IMPLEMENTATION_REVIEW_STATUS)).to.throw(
      "chain ID mismatch"
    );
    expect(() => resolveNetworkConfig("mainnet", 1n, instances, PRODUCTION_REVIEW_STATUS)).to.throw(
      "No v2 source configuration"
    );
    expect(() => resolveNetworkConfig("chikyu", 6281971n, instances, IMPLEMENTATION_REVIEW_STATUS)).to.throw(
      "No v2 source configuration"
    );
  });

  it("keeps INR fallback and NGN derived-yield evidence explicit", () => {
    const manifest = loadAndValidateRateManifest(loadInstances());
    const inr = manifest.rates.find((rate) => rate.code === "INR") as unknown as {
      observationDate: string;
      newerAuction: { observationDate: string; status: string };
    };
    expect(inr.observationDate).to.equal("2026-10-14");
    expect(inr.newerAuction.observationDate).to.equal("2026-10-21");
    expect(inr.newerAuction.status).to.contain("NIL");
    const ngn = manifest.rates.find((rate) => rate.code === "NGN");
    expect(ngn.originalUnit).to.contain("discount");
    expect(ngn.normalizationFormula).to.contain("100 - 15.9000");
  });

  it("keeps the CHF ten-year testnet exception explicit", () => {
    const manifest = loadAndValidateRateManifest(loadInstances());
    const chf = manifest.rates.find((rate) => rate.code === "CHF");
    expect(chf.tenor).to.equal("10 years");
    expect(chf.observationDate).to.equal("2026-10-28");
    expect(chf.retrievalDate).to.equal("2026-10-29");
    expect(chf.evidenceStatus).to.contain("testnet-only ten-year exception");
    expect(chf.normalizedAnnualYieldPercent).to.equal("0.4950");
    expect(chf.leadratePPM).to.equal(19950);
  });
});
