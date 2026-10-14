import { HardhatRuntimeEnvironment } from "hardhat/types";

/**
 * Currency-agnostic instance configuration. instances/instances.json is the single source of
 * truth for the seven DogeForex currencies (K9USD...K9BRL); deploy scripts iterate this list so
 * every instance is deployed from the same audited bytecode with different constructor args.
 */
export interface BootstrapConfig {
  // null recipients default to the deployer (testnet convenience); set real addresses (Ops Safe)
  // before any mainnet deployment.
  poolSeedRecipient: string | null;
  equityRecipient: string | null;
  challengerBountyRecipient: string | null;
  incentivesRecipient: string | null;
  poolSeedAmount: string; // decimal-string wei amounts
  equityAmount: string;
  challengerBountyAmount: string;
  incentivesAmount: string;
  durationDays: number; // sale endTime = deploy time + durationDays
}

export interface InstanceConfig {
  code: string; // ISO 4217 currency code; also the per-instance deploy tag
  tokenName: string; // ERC20 name constructor arg, e.g. "DogeForex Dollar"
  tokenSymbol: string; // ERC20 symbol constructor arg, e.g. "K9USD"
  leadratePPM: number; // genesis savings/leadrate rate
  guardian: string | null; // initial guardian key (3-of-5 Ops Safe) for the GuardianTimelock; null = admission gate not wired
  bootstrap: BootstrapConfig | null; // genesis float; null = skip 06_genesis_bootstrap for this instance
}

export function deploymentName(inst: InstanceConfig, contract: string): string {
  return `${inst.code}_${contract}`;
}

export function loadInstances(): InstanceConfig[] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(__dirname + "/instances/instances.json") as InstanceConfig[];
}

/**
 * When --tags <CODE> is given, restrict the run to exactly those currency instances. The
 * stage tags (00_deploy_all / 06_genesis_bootstrap / 07_guardian_timelock) run all instances.
 * hardhat-deploy keeps task params out of hre.hardhatArguments, so parse process.argv.
 */
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
  const codes = tags.filter((t) => instances.some((i) => i.code === t));
  if (codes.length === 0) return instances;
  return instances.filter((i) => codes.includes(i.code));
}

export function minApplicationPeriodFor(chainId: number): number {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const params = require(__dirname + "/parameters/paramsOracleFreeDollar.json") as Array<{
    chainId: number;
    minApplicationPeriod: number;
  }>;
  const hit = params.find((p) => p.chainId === chainId);
  if (!hit) throw new Error(`No minApplicationPeriod configured for chainId ${chainId}`);
  return hit.minApplicationPeriod;
}
