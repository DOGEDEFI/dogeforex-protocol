import { parseUnits } from "ethers";

export const IMPLEMENTATION_REVIEW_STATUS = "implementation-reviewed / production-refresh-required";
export const PRODUCTION_REVIEW_STATUS = "production-approved";
export const REQUIRED_SPREAD_PPM = 15000;

const UINT24_MAX = 16_777_215n;
const PPM_SCALE = 10n ** 14n;
const PPM_ROUNDING_HALF = 5n * 10n ** 13n;
const EXPECTED_CODES = ["USD", "EUR", "JPY", "GBP", "AUD", "CNY", "BRL", "PKR", "BDT", "INR", "NGN"];

export interface RateInstance {
  code: string;
  leadratePPM: number;
}

export interface InitialLeadrateEvidence {
  code: string;
  instrument: string;
  series: string;
  tenor: string;
  observationDate: string;
  retrievalDate: string;
  sourceUrl: string;
  sourceType: string;
  originalYieldPercent: string;
  originalUnit: string;
  quoteConvention: string;
  normalizationFormula: string;
  normalizedAnnualYieldPercent: string;
  spreadPPM: number;
  roundingRule: string;
  leadratePPM: number;
  reviewStatus: string;
}

export interface InitialLeadratesManifest {
  schemaVersion: number;
  snapshot: string;
  reviewStatus: string;
  timestampPrecision: string;
  spreadPPM: number;
  spreadPolicy: string;
  roundingRule: string;
  productionRefreshRule: string;
  rates: InitialLeadrateEvidence[];
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireDate(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must be an ISO calendar date (YYYY-MM-DD)`);
  }
}

function requirePpm(value: unknown, label: string): bigint {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative safe integer`);
  }
  const result = BigInt(value);
  if (result > UINT24_MAX) {
    throw new Error(`${label}=${result} exceeds uint24 maximum ${UINT24_MAX}; refusing to clamp`);
  }
  return result;
}

function parseDecimal(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a nonnegative decimal string without exponents or a sign`);
  }
  try {
    return parseUnits(value, 18);
  } catch {
    throw new Error(`${label}=${value} must have at most 18 fractional digits and fit uint256`);
  }
}

export function leadrateFromNormalized(normalizedAnnualYieldPercent: string, spreadPPM: number, label: string): bigint {
  const scaled = parseDecimal(normalizedAnnualYieldPercent, `${label}.normalizedAnnualYieldPercent`);
  const spread = requirePpm(spreadPPM, `${label}.spreadPPM`);
  const result = (scaled + PPM_ROUNDING_HALF) / PPM_SCALE + spread;
  if (result > UINT24_MAX) {
    throw new Error(`${label} computed leadrate ${result} exceeds uint24 maximum ${UINT24_MAX}; refusing to clamp`);
  }
  return result;
}

export function loadAndValidateRateManifest(instances: RateInstance[]): InitialLeadratesManifest {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const manifest = require(__dirname + "/initial-leadrates.json") as InitialLeadratesManifest;
  if (manifest.schemaVersion !== 1) throw new Error("initial-leadrates schemaVersion must be 1");
  requireText(manifest.snapshot, "initial-leadrates.snapshot");
  requireText(manifest.timestampPrecision, "initial-leadrates.timestampPrecision");
  requireText(manifest.spreadPolicy, "initial-leadrates.spreadPolicy");
  requireText(manifest.roundingRule, "initial-leadrates.roundingRule");
  requireText(manifest.productionRefreshRule, "initial-leadrates.productionRefreshRule");
  if (manifest.reviewStatus !== IMPLEMENTATION_REVIEW_STATUS && manifest.reviewStatus !== PRODUCTION_REVIEW_STATUS) {
    throw new Error(`initial-leadrates.reviewStatus is not recognized: ${manifest.reviewStatus}`);
  }
  if (requirePpm(manifest.spreadPPM, "initial-leadrates.spreadPPM") !== BigInt(REQUIRED_SPREAD_PPM)) {
    throw new Error(`initial-leadrates.spreadPPM must equal ${REQUIRED_SPREAD_PPM}`);
  }
  if (!Array.isArray(manifest.rates)) throw new Error("initial-leadrates.rates must be an array");
  if (!Array.isArray(instances)) throw new Error("instances must be an array");

  const instanceCodes = new Set<string>();
  for (const instance of instances) {
    if (instanceCodes.has(instance.code)) throw new Error(`Duplicate instance code ${instance.code}`);
    instanceCodes.add(instance.code);
  }
  const evidenceByCode = new Map<string, InitialLeadrateEvidence>();
  for (const evidence of manifest.rates) {
    if (evidenceByCode.has(evidence.code)) throw new Error(`Duplicate initial-leadrates code ${evidence.code}`);
    evidenceByCode.set(evidence.code, evidence);
  }

  if (instances.length !== EXPECTED_CODES.length || manifest.rates.length !== EXPECTED_CODES.length) {
    throw new Error(`Exactly ${EXPECTED_CODES.length} instance and rate records are required: ${EXPECTED_CODES.join(", ")}`);
  }

  for (const code of EXPECTED_CODES) {
    const instance = instances.find((candidate) => candidate.code === code);
    const evidence = evidenceByCode.get(code);
    if (!instance) throw new Error(`Missing currency instance ${code}`);
    if (!evidence) throw new Error(`Missing initial-leadrates evidence for ${code}`);

    const label = `initial-leadrates.${code}`;
    requireText(evidence.instrument, `${label}.instrument`);
    requireText(evidence.series, `${label}.series`);
    requireText(evidence.tenor, `${label}.tenor`);
    requireDate(evidence.observationDate, `${label}.observationDate`);
    requireDate(evidence.retrievalDate, `${label}.retrievalDate`);
    requireText(evidence.sourceType, `${label}.sourceType`);
    requireText(evidence.originalUnit, `${label}.originalUnit`);
    requireText(evidence.quoteConvention, `${label}.quoteConvention`);
    requireText(evidence.normalizationFormula, `${label}.normalizationFormula`);
    requireText(evidence.roundingRule, `${label}.roundingRule`);
    const sourceUrl = requireText(evidence.sourceUrl, `${label}.sourceUrl`);
    if (!sourceUrl.startsWith("https://")) throw new Error(`${label}.sourceUrl must use HTTPS`);
    if (evidence.reviewStatus !== manifest.reviewStatus) {
      throw new Error(`${label}.reviewStatus must match the manifest reviewStatus`);
    }

    const original = parseDecimal(evidence.originalYieldPercent, `${label}.originalYieldPercent`);
    const normalized = parseDecimal(evidence.normalizedAnnualYieldPercent, `${label}.normalizedAnnualYieldPercent`);
    if (evidence.normalizationFormula.startsWith("identity") && original !== normalized) {
      throw new Error(`${label} identity normalization requires original and normalized yields to be equal`);
    }
    if (requirePpm(evidence.spreadPPM, `${label}.spreadPPM`) !== BigInt(REQUIRED_SPREAD_PPM)) {
      throw new Error(`${label}.spreadPPM must equal ${REQUIRED_SPREAD_PPM}`);
    }

    const computed = leadrateFromNormalized(evidence.normalizedAnnualYieldPercent, evidence.spreadPPM, label);
    const recorded = requirePpm(evidence.leadratePPM, `${label}.leadratePPM`);
    const configured = requirePpm(instance.leadratePPM, `instances.${code}.leadratePPM`);
    if (recorded !== computed) {
      throw new Error(`${label}.leadratePPM=${recorded} does not match exact decimal calculation ${computed}`);
    }
    if (configured !== computed) {
      throw new Error(`instances.${code}.leadratePPM=${configured} does not match evidence calculation ${computed}`);
    }
  }
  return manifest;
}
