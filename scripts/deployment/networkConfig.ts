import { getAddress, parseUnits, ZeroAddress } from "ethers";
import { InstanceConfig } from "./instanceConfig";
import { PRODUCTION_REVIEW_STATUS } from "./rateConfig";

const TEST_NETWORKS = new Set(["hardhat", "chikyuV2"]);
const TEST_BRIDGE_LIMIT = parseUnits("1000000", 18);
const BOOTSTRAP_LOCAL = parseUnits("100", 18);

export interface TestSourceConfig {
  kind: "test-usdc";
  decimals: number;
  symbol: string;
}

export interface ApprovedSourceConfig {
  kind: "approved-erc20";
  address: string;
  decimals: number;
  reviewStatus: string;
  provenance?: string;
}

export interface ReviewedBridgeLimit {
  localUnits: string;
  reviewStatus: string;
}

export interface NetworkFileConfig {
  chainId: number;
  source: TestSourceConfig | ApprovedSourceConfig;
  testBridgeLimitLocal?: string;
  bridgeLimits?: Record<string, ReviewedBridgeLimit>;
}

export interface ResolvedNetworkConfig {
  name: string;
  chainId: bigint;
  isTest: boolean;
  source: TestSourceConfig | ApprovedSourceConfig;
  bridgeLimits: Record<string, bigint>;
}

function requireDecimals(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 18) {
    throw new Error(`${label} must be an integer from 0 through 18`);
  }
  return value;
}

function parseLocalLimit(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a nonnegative decimal string in local 18-decimal units`);
  }
  let parsed: bigint;
  try {
    parsed = parseUnits(value, 18);
  } catch {
    throw new Error(`${label}=${value} has too many fractional digits or exceeds uint256`);
  }
  if (parsed < BOOTSTRAP_LOCAL) {
    throw new Error(`${label} must be at least the 100-unit bootstrap amount`);
  }
  return parsed;
}

export function resolveNetworkConfig(
  networkName: string,
  providerChainId: bigint,
  instances: InstanceConfig[],
  rateReviewStatus: string
): ResolvedNetworkConfig {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const networks = require(__dirname + "/networks.json") as Record<string, NetworkFileConfig>;
  const config = networks[networkName];
  if (!config) {
    throw new Error(
      `No v2 source configuration for network ${networkName}. Add an explicit networks.json entry with an approved nonzero production source and reviewed per-currency caps; test assets are only permitted on hardhat and chikyuV2.`
    );
  }
  if (typeof config.chainId !== "number" || !Number.isSafeInteger(config.chainId) || config.chainId <= 0) {
    throw new Error(`networks.${networkName}.chainId must be a positive safe integer`);
  }
  const expectedChainId = BigInt(config.chainId);
  if (providerChainId !== expectedChainId) {
    throw new Error(`Network ${networkName} chain ID mismatch: config=${expectedChainId}, provider=${providerChainId}`);
  }
  if (!config.source || typeof config.source.kind !== "string") {
    throw new Error(`networks.${networkName}.source.kind is required`);
  }

  const bridgeLimits: Record<string, bigint> = {};
  if (config.source.kind === "test-usdc") {
    if (!TEST_NETWORKS.has(networkName)) {
      throw new Error(`TestUSDC is forbidden on network ${networkName}; only hardhat and chikyuV2 may use it`);
    }
    if (requireDecimals(config.source.decimals, `networks.${networkName}.source.decimals`) !== 6) {
      throw new Error(`networks.${networkName}.source.decimals must be 6 for TestUSDC`);
    }
    if (config.source.symbol !== "tUSDC") {
      throw new Error(`networks.${networkName}.source.symbol must be tUSDC`);
    }
    const limit = parseLocalLimit(config.testBridgeLimitLocal, `networks.${networkName}.testBridgeLimitLocal`);
    if (limit !== TEST_BRIDGE_LIMIT) {
      throw new Error(`networks.${networkName}.testBridgeLimitLocal must be exactly 1000000 local units`);
    }
    for (const instance of instances) bridgeLimits[instance.code] = limit;
    return { name: networkName, chainId: expectedChainId, isTest: true, source: config.source, bridgeLimits };
  }

  if (config.source.kind !== "approved-erc20") {
    throw new Error(`networks.${networkName}.source.kind is unsupported; refusing any mock or implicit source fallback`);
  }
  if (rateReviewStatus !== PRODUCTION_REVIEW_STATUS) {
    throw new Error(
      `Network ${networkName} requires a production-refreshed initial-leadrates.json with reviewStatus ${PRODUCTION_REVIEW_STATUS}; current status is ${rateReviewStatus}`
    );
  }
  if (config.source.reviewStatus !== PRODUCTION_REVIEW_STATUS) {
    throw new Error(`networks.${networkName}.source must be explicitly ${PRODUCTION_REVIEW_STATUS}`);
  }
  let sourceAddress: string;
  try {
    sourceAddress = getAddress(config.source.address);
  } catch {
    throw new Error(`networks.${networkName}.source.address is not a valid address`);
  }
  if (sourceAddress === ZeroAddress) throw new Error(`networks.${networkName}.source.address must be nonzero`);
  requireDecimals(config.source.decimals, `networks.${networkName}.source.decimals`);

  for (const instance of instances) {
    const reviewed = config.bridgeLimits?.[instance.code];
    if (!reviewed) throw new Error(`networks.${networkName}.bridgeLimits.${instance.code} is required`);
    if (reviewed.reviewStatus !== PRODUCTION_REVIEW_STATUS) {
      throw new Error(`networks.${networkName}.bridgeLimits.${instance.code} must be explicitly ${PRODUCTION_REVIEW_STATUS}`);
    }
    bridgeLimits[instance.code] = parseLocalLimit(
      reviewed.localUnits,
      `networks.${networkName}.bridgeLimits.${instance.code}.localUnits`
    );
  }

  return {
    name: networkName,
    chainId: expectedChainId,
    isTest: false,
    source: { ...config.source, address: sourceAddress },
    bridgeLimits,
  };
}
