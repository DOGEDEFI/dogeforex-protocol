import { parseUnits } from "ethers";

export function ceilDiv(value: bigint, divisor: bigint): bigint {
  if (value < 0n || divisor <= 0n) throw new Error("ceilDiv requires a nonnegative value and positive divisor");
  return (value + divisor - 1n) / divisor;
}

export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error("Square root requires a nonnegative integer");
  if (value < 2n) return value;
  let current = value;
  let next = (current + 1n) / 2n;
  while (next < current) {
    current = next;
    next = (current + value / current) / 2n;
  }
  return current;
}

export function sqrtPriceX96(
  token0Decimals: number,
  token1Decimals: number,
  priceNumerator: string,
  priceDenominator: string
): bigint {
  if (!Number.isInteger(token0Decimals) || !Number.isInteger(token1Decimals)) throw new Error("Decimals must be integers");
  if (token0Decimals < 0 || token1Decimals < 0 || token0Decimals > 36 || token1Decimals > 36) throw new Error("Decimals out of range");
  let numerator = BigInt(priceNumerator);
  let denominator = BigInt(priceDenominator);
  if (numerator <= 0n || denominator <= 0n) throw new Error("Pool price must be positive");
  const shift = token1Decimals - token0Decimals;
  if (shift >= 0) numerator *= 10n ** BigInt(shift);
  else denominator *= 10n ** BigInt(-shift);
  const result = isqrt((numerator << 192n) / denominator);
  if (result <= 0n || result >= (1n << 160n)) throw new Error("Pool price is outside the uint160 range");
  return result;
}

export function poolTickRange(configuredLower: number, configuredUpper: number, tickSpacing: bigint): { tickLower: number; tickUpper: number } {
  const spacing = Number(tickSpacing);
  if (!Number.isInteger(configuredLower) || !Number.isInteger(configuredUpper) || !Number.isInteger(spacing) || spacing <= 0) throw new Error(`Invalid tick range: lower=${configuredLower}, upper=${configuredUpper}, spacing=${spacing}`);
  const tickLower = Math.floor(configuredLower / spacing) * spacing;
  const tickUpper = Math.ceil(configuredUpper / spacing) * spacing;
  if (tickLower >= tickUpper) throw new Error("Pool tick range is empty");
  return { tickLower, tickUpper };
}

export function selectedCurrencies(allCurrencies: string[], pilot?: string): string[] {
  if (pilot && !allCurrencies.includes(pilot)) throw new Error("Unknown currency pilot");
  return pilot ? [pilot] : allCurrencies;
}

export interface RolloutFeePolicy {
  feeCapTDOGE: string;
  transactionFeeCapTDOGE: string;
  maxL1FeePerByteTDOGE: string;
}

export function feePolicyForPilot(config: RolloutFeePolicy & { pilotFeePolicies?: Record<string, RolloutFeePolicy> }, pilot?: string): RolloutFeePolicy {
  return {
    feeCapTDOGE: config.feeCapTDOGE,
    transactionFeeCapTDOGE: config.transactionFeeCapTDOGE,
    maxL1FeePerByteTDOGE: config.maxL1FeePerByteTDOGE,
    ...config.pilotFeePolicies?.[pilot ?? ""],
  };
}

export function positionCollateral(priceLocal: string, ratioPercent: number, capLocal = "10000"): {
  priceRaw: bigint;
  capRaw: bigint;
  collateralRaw: bigint;
  minCollateralRaw: bigint;
} {
  if (!Number.isInteger(ratioPercent) || ratioPercent < 110 || ratioPercent > 200) throw new Error("Collateral ratio must be between 110% and 200%");
  const priceRaw = parseUnits(priceLocal, 18);
  if (priceRaw <= 0n) throw new Error("Position price must be positive");
  const capRaw = parseUnits(capLocal, 18);
  const collateralRaw = ceilDiv(capRaw * BigInt(ratioPercent) * (10n ** 18n), priceRaw * 100n);
  const minCollateralRaw = ceilDiv(parseUnits("3500", 18) * (10n ** 18n), priceRaw);
  if (collateralRaw * priceRaw * 100n < capRaw * BigInt(ratioPercent)) throw new Error("Collateral ratio rounding failed");
  if (minCollateralRaw * priceRaw > capRaw * (10n ** 18n)) throw new Error("Minimum collateral exceeds the mint cap price bound");
  return { priceRaw, capRaw, collateralRaw, minCollateralRaw };
}
