import { HardhatRuntimeEnvironment } from "hardhat/types";
import { InitialLeadratesManifest, loadAndValidateRateManifest } from "./rateConfig";

export interface InstanceConfig {
  code: string;
  tokenName: string;
  tokenSymbol: string;
  leadratePPM: number;
}

export function deploymentName(inst: InstanceConfig, contract: string): string {
  return `${inst.code}_${contract}`;
}

export function loadInstances(): InstanceConfig[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(__dirname + "/instances/instances.json") as InstanceConfig[];
}

export function validateInstances(instances: InstanceConfig[]): InitialLeadratesManifest {
  if (!Array.isArray(instances)) throw new Error("instances.json must contain an array");
  const symbols = new Set<string>();
  for (const instance of instances) {
    if (!/^[A-Z]{3}$/.test(instance.code)) throw new Error(`Invalid three-letter currency code: ${instance.code}`);
    if (typeof instance.tokenName !== "string" || instance.tokenName.length === 0) {
      throw new Error(`${instance.code}.tokenName must be non-empty`);
    }
    if (typeof instance.tokenSymbol !== "string" || instance.tokenSymbol.length === 0) {
      throw new Error(`${instance.code}.tokenSymbol must be non-empty`);
    }
    if (symbols.has(instance.tokenSymbol)) throw new Error(`Duplicate token symbol ${instance.tokenSymbol}`);
    symbols.add(instance.tokenSymbol);
  }
  return loadAndValidateRateManifest(instances);
}

export function selectInstances(hre: HardhatRuntimeEnvironment, instances: InstanceConfig[]): InstanceConfig[] {
  const argv = process.argv;
  let tags: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--tags") {
      for (let j = i + 1; j < argv.length && !argv[j].startsWith("--"); j++) {
        tags.push(...argv[j].split(","));
      }
    } else if (argv[i].startsWith("--tags=")) {
      tags.push(...argv[i].slice("--tags=".length).split(","));
    }
  }
  const codes = tags.filter((tag) => instances.some((instance) => instance.code === tag));
  if (codes.length === 0) return instances;
  return instances.filter((instance) => codes.includes(instance.code));
}

export function minApplicationPeriodFor(chainId: number): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const params = require(__dirname + "/parameters/paramsOracleFreeDollar.json") as Array<{
    chainId: number;
    minApplicationPeriod: number;
  }>;
  const hit = params.find((candidate) => candidate.chainId === chainId);
  if (!hit) throw new Error(`No minApplicationPeriod configured for chainId ${chainId}`);
  if (!Number.isSafeInteger(hit.minApplicationPeriod) || hit.minApplicationPeriod <= 0) {
    throw new Error(`Invalid minApplicationPeriod for chainId ${chainId}`);
  }
  return hit.minApplicationPeriod;
}
