import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import "hardhat-deploy";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "ethers";
import { loadInstances, minApplicationPeriodFor, validateInstances } from "./instanceConfig";
import { resolveNetworkConfig } from "./networkConfig";
import { getTotalFeeGuard } from "./v2FeeGuard";

const root = join(__dirname, "../..");
const config = JSON.parse(readFileSync(join(root, "scripts/execution/demoRollout.config.json"), "utf8"));

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n");
  renameSync(temporary, path);
}

async function main(): Promise<void> {
  if (!process.versions.node.startsWith("20.")) throw new Error("Use Node 20 for the demo rollout preflight");
  if (hre.network.name !== "chikyuV2" || hre.network.config.chainId !== Number(config.chainId)) throw new Error("Wrong rollout network");
  if (process.env.IMF_V2_DEPLOYMENT_SCOPE !== "DEMO_ROLLOUT") throw new Error("Preflight requires DEMO_ROLLOUT scope");
  const owner = getAddress(config.owner);
  const named = await hre.getNamedAccounts();
  const signer = await hre.ethers.getSigner(named.deployer);
  if (getAddress(await signer.getAddress()) !== owner || getAddress(process.env.IMF_V2_DEPLOYER ?? "") !== owner) throw new Error("Signer is not the established demo deployer");
  const guard = getTotalFeeGuard(hre.network.name);
  try {
    const instances = loadInstances();
    const rateManifest = validateInstances(instances);
    const network = resolveNetworkConfig(hre.network.name, BigInt(config.chainId), instances, rateManifest.reviewStatus);
    if (!network.isTest || network.source.kind !== "test-usdc") throw new Error("Rollout must use shared test tUSDC");
    const source = await hre.ethers.getContractAt("TestUSDC", config.source, signer);
    if (getAddress(await source.deployer()) !== owner) throw new Error("Signer is not the source minter");
    const planned: Array<Record<string, string>> = [];
    const missing: string[] = [];
    const blockers: string[] = [];
    let plannedFee = 0n;
    const localToken = JSON.parse(readFileSync(join(root, "scripts/deployment/deployments/chikyuV2/USD_V2Registry.json"), "utf8")).linkedData.addresses.Token as string;
    for (const code of config.newCurrencies) {
      const registryPath = join(root, `scripts/deployment/deployments/chikyuV2/${code}_V2Registry.json`);
      const instance = instances.find((candidate) => candidate.code === code);
      if (!instance) throw new Error(`Missing instance ${code}`);
      if (existsSync(registryPath)) continue;
      missing.push(code);
      const creations = [
        { name: "Token", contract: "OracleFreeDollar", args: [minApplicationPeriodFor(Number(config.chainId)), instance.tokenName, instance.tokenSymbol] },
        { name: "PositionFactory", contract: "PositionFactory", args: [] },
        { name: "PositionRoller", contract: "PositionRoller", args: [localToken] },
        { name: "Savings", contract: "Savings", args: [localToken, instance.leadratePPM] },
        { name: "MintingHub", contract: "MintingHub", args: [localToken, localToken, localToken, localToken] },
        { name: "Bridge", contract: "StablecoinBridge", args: [config.source, localToken, network.bridgeLimits[code]] },
      ];
      for (const creation of creations) {
        const factory = await hre.ethers.getContractFactory(creation.contract);
        const transaction = await factory.getDeployTransaction(...creation.args);
        const quotedBytes = BigInt((transaction.data.length - 2) / 2 + 128);
        const [l1Fee, gas] = await Promise.all([
          guard.quoteL1(transaction.data + "00".repeat(128)),
          hre.ethers.provider.estimateGas({ from: owner, data: transaction.data }),
        ]);
        const reserved = l1Fee * 2n + gas * guard.maxGasPrice;
        plannedFee += reserved;
        if (l1Fee > guard.maxL1FeePerByte * quotedBytes) blockers.push(`${code}/${creation.name} exceeds the L1 per-byte safety ceiling`);
        if (reserved > guard.maxTransactionFee) blockers.push(`${code}/${creation.name} exceeds the per-transaction ceiling`);
        planned.push({ code, contract: creation.contract, calldataBytes: String((transaction.data.length - 2) / 2), estimatedGas: gas.toString(), quotedL1FeeWei: l1Fee.toString(), conservativeReservedFeeWei: reserved.toString() });
      }
    }
    const ordinaryL1 = await guard.quoteL1("0x" + "01".repeat(512));
    const ordinaryFee = ordinaryL1 * 2n + 2_000_000n * guard.maxGasPrice;
    const stages = {
      bootstrapAndBridgeFunding: config.allCurrencies.length * 12,
      demoTokenDeployments: config.demoTokens.length,
      poolCreationInitializationAllowancesAndMints: config.demoTokens.length * 6,
      positionApprovalsAndOpenings: config.allCurrencies.length * config.positions.length * 2,
      dueMints: config.allCurrencies.length * config.positions.length,
      equityInvestments: config.allCurrencies.length,
    };
    const ordinaryCount = Object.values(stages).reduce((total, count) => total + count, 0);
    const remainingStageAllowance = ordinaryFee * BigInt(ordinaryCount);
    plannedFee += remainingStageAllowance;
    if (guard.spentFee() + guard.reservedFee() + plannedFee > guard.maxTotalFee) blockers.push("Conservative aggregate estimate exceeds the configured total fee cap");
    const report = {
      schemaVersion: "1.0",
      network: hre.network.name,
      chainId: config.chainId,
      scope: "DEMO_ROLLOUT",
      checkedAt: new Date().toISOString(),
      complete: false,
      status: blockers.length ? "blocked" : "affordable-estimate",
      blockers,
      owner,
      missingCurrencies: missing,
      alreadyDeployedCurrencies: config.newCurrencies.filter((code: string) => !missing.includes(code)),
      bridgeTargetSourceRaw: config.bridgeTargetSource,
      bridgeTargetLocalRaw: config.bridgeTargetLocal,
      plannedCreations: planned,
      remainingStageTransactions: stages,
      ordinaryTransactionConservativeFeeWei: ordinaryFee.toString(),
      remainingStageAllowanceWei: remainingStageAllowance.toString(),
      conservativeTotalFeeWei: plannedFee.toString(),
      spentFeeWei: guard.spentFee().toString(),
      reservedFeeWei: guard.reservedFee().toString(),
      maximumTotalFeeWei: guard.maxTotalFee.toString(),
      broadcast: false,
    };
    writeJson(join(root, "scripts/deployment/deployments/chikyuV2/demo-preflight.json"), report);
    console.log(JSON.stringify(report, null, 2));
    if (blockers.length) throw new Error(blockers.join("; "));
  } finally {
    guard.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
