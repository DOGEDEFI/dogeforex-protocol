import hre from "hardhat";
import { getAddress } from "ethers";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadInstances, minApplicationPeriodFor, validateInstances } from "./instanceConfig";
import { resolveNetworkConfig } from "./networkConfig";
import {
  CHIKYU_CHAIN_ID,
  MAX_L1_FEE_PER_BYTE,
  REFERENCE_L1_FEE_PER_BYTE,
  getTotalFeeGuard,
  receiptTotalFee,
} from "./v2FeeGuard";

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n");
  renameSync(temporary, path);
}

function ensureDeploymentChainId(chainId: bigint): void {
  const directory = join(__dirname, "deployments", "chikyuV2");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, ".chainId");
  try {
    if (readFileSync(path, "utf8").trim() !== chainId.toString()) {
      throw new Error("The existing chikyuV2 deployment directory belongs to a different chain");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    writeFileSync(path, chainId.toString() + "\n", { flag: "wx" });
  }
}

async function main(): Promise<void> {
  if (!process.versions.node.startsWith("20.")) throw new Error("Use the repository's Node 20 runtime for Chikyu deployment");
  if (hre.network.name !== "chikyuV2" || hre.network.config.chainId !== Number(CHIKYU_CHAIN_ID)) {
    throw new Error("Preflight requires the separate chikyuV2 network");
  }
  const providerNetwork = await hre.ethers.provider.getNetwork();
  if (providerNetwork.chainId !== CHIKYU_CHAIN_ID) throw new Error("The RPC endpoint is not Chikyu");
  if (process.env.IMF_V2_DEPLOYMENT_SCOPE !== "USD") throw new Error("This preflight is restricted to USD");
  ensureDeploymentChainId(providerNetwork.chainId);
  const guard = getTotalFeeGuard(hre.network.name);
  try {
    const instances = loadInstances();
    const rateManifest = validateInstances(instances);
    const instance = instances.find((candidate) => candidate.code === "USD");
    if (!instance) throw new Error("USD instance configuration is missing");
    const network = resolveNetworkConfig(hre.network.name, providerNetwork.chainId, instances, rateManifest.reviewStatus);
    if (!network.isTest || network.source.kind !== "test-usdc") throw new Error("Chikyu V2 must use the shared six-decimal tUSDC");
    const legacy = JSON.parse(readFileSync(join(__dirname, "../../deployments/k9usd.chikyu.json"), "utf8")) as {
      roles: { deployer: string };
    };
    const expectedDeployer = getAddress(legacy.roles.deployer);
    const { deployer } = await hre.getNamedAccounts();
    if (getAddress(deployer) !== expectedDeployer || getAddress(process.env.IMF_V2_DEPLOYER ?? "") !== expectedDeployer) {
      throw new Error("The configured signer, fee guard, and established deployer do not match");
    }
    const signer = await hre.ethers.getSigner(deployer);
    if ((await signer.getAddress()) !== expectedDeployer) throw new Error("The actual signer is not the established deployer");
    const balance = await hre.ethers.provider.getBalance(deployer);
    if (balance < guard.maxTotalFee) {
      throw new Error(`Deployer balance ${balance} is below the guarded deployment budget ${guard.maxTotalFee}`);
    }
    const block = await hre.ethers.provider.getBlock("latest");
    if (!block) throw new Error("Chikyu has no latest block");
    const creations = [
      { name: "TestUSDC", contract: "TestUSDC", args: [] },
      {
        name: "USD_Token",
        contract: "OracleFreeDollar",
        args: [minApplicationPeriodFor(Number(CHIKYU_CHAIN_ID)), instance.tokenName, instance.tokenSymbol],
      },
      { name: "USD_PositionFactory", contract: "PositionFactory", args: [] },
      { name: "USD_PositionRoller", contract: "PositionRoller", args: [deployer] },
      { name: "USD_Savings", contract: "Savings", args: [deployer, instance.leadratePPM] },
      { name: "USD_MintingHub", contract: "MintingHub", args: [deployer, deployer, deployer, deployer] },
      { name: "USD_Bridge", contract: "StablecoinBridge", args: [deployer, deployer, network.bridgeLimits.USD] },
    ];
    const planned: Array<Record<string, string>> = [];
    const blockers: string[] = [];
    const quoteInputs: Array<{ name: string; unsignedBytes: number; signedAllowance: string }> = [];
    let plannedFee = 0n;
    for (const creation of creations) {
      const factory = await hre.ethers.getContractFactory(creation.contract);
      const transaction = await factory.getDeployTransaction(...creation.args);
      quoteInputs.push({
        name: creation.name,
        unsignedBytes: (transaction.data.length - 2) / 2,
        signedAllowance: transaction.data + "00".repeat(128),
      });
    }
    const quoteBlock = "0x" + block.number.toString(16);
    const [creationL1Fees, ordinaryL1Fee, probeL1Fee] = await Promise.all([
      Promise.all(quoteInputs.map((input) => guard.quoteL1(input.signedAllowance, quoteBlock))),
      guard.quoteL1("0x" + "01".repeat(512), quoteBlock),
      guard.quoteL1("0x" + "01".repeat(128), quoteBlock),
    ]);
    for (let index = 0; index < quoteInputs.length; index++) {
      const input = quoteInputs[index];
      const quotedBytes = BigInt(input.unsignedBytes + 128);
      const l1Fee = creationL1Fees[index];
      const maximumL1Fee = MAX_L1_FEE_PER_BYTE * quotedBytes;
      const executionCeiling = BigInt(block.gasLimit) * guard.maxGasPrice;
      const guardedFee = l1Fee * 2n + executionCeiling;
      plannedFee += guardedFee;
      if (l1Fee > maximumL1Fee) blockers.push(`${input.name} L1 quote ${l1Fee} exceeds ${maximumL1Fee} wei`);
      if (guardedFee > guard.maxTransactionFee) {
        blockers.push(`${input.name} reserved fee ${guardedFee} exceeds ${guard.maxTransactionFee} wei`);
      }
      planned.push({
        name: input.name,
        calldataBytes: input.unsignedBytes.toString(),
        quotedBytes: quotedBytes.toString(),
        quotedL1FeeWei: l1Fee.toString(),
        maximumL1FeeWei: maximumL1Fee.toString(),
        executionGasCeiling: block.gasLimit.toString(),
        executionGasPriceCeilingWei: guard.maxGasPrice.toString(),
        guardedFeeWei: guardedFee.toString(),
      });
    }
    const ordinaryGasCeiling = 2_000_000n;
    const ordinaryFee = ordinaryL1Fee * 2n + ordinaryGasCeiling * guard.maxGasPrice;
    plannedFee += ordinaryFee * 9n;
    const probeFeeAllowance = probeL1Fee * 2n + 21_000n * guard.maxGasPrice;
    plannedFee += probeFeeAllowance;
    if (guard.spentFee() + guard.reservedFee() + plannedFee > guard.maxTotalFee) {
      blockers.push(`Total planned fee ${plannedFee} plus existing costs exceeds ${guard.maxTotalFee} wei`);
    }
    if (blockers.length > 0 || process.env.IMF_V2_ESTIMATE_ONLY === "1") {
      const report = {
        schemaVersion: "1.0",
        network: hre.network.name,
        chainId: providerNetwork.chainId.toString(),
        quoteBlock,
        code: "USD",
        checkedAt: new Date().toISOString(),
        complete: false,
        status: blockers.length > 0 ? "fee-regime-blocked" : "affordable-estimate",
        blockers,
        deployer: expectedDeployer,
        initialSharesCustody: expectedDeployer,
        source: network.source,
        rateEvidence: rateManifest.rates.find((candidate) => candidate.code === "USD"),
        plannedCreations: planned,
        ordinaryTransactionFeeAllowanceWei: ordinaryFee.toString(),
        conservativeRemainingPlanFeeWei: plannedFee.toString(),
        spentFeeWei: guard.spentFee().toString(),
        reservedFeeWei: guard.reservedFee().toString(),
        maximumTotalFeeWei: guard.maxTotalFee.toString(),
        broadcast: false,
      };
      writeJson(join(__dirname, "deployments/chikyuV2/USD_Preflight.json"), report);
      if (blockers.length > 0) throw new Error(`V2 deployment fee preflight blocked: ${blockers.join("; ")}`);
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    guard.labelNextTransaction("native-fee-probe");
    const probe = await signer.sendTransaction({ to: expectedDeployer, value: 0, data: "0x" });
    const receipt = await probe.wait(1);
    if (!receipt) throw new Error("The fee probe has no receipt");
    const rawReceipt = (await hre.network.provider.request({
      method: "eth_getTransactionReceipt",
      params: [probe.hash],
    })) as { gasUsed: string; effectiveGasPrice: string; l1Fee?: string };
    const actual = receiptTotalFee(rawReceipt);
    if (actual.l1Fee === 0n) throw new Error("The native fee probe has no observable L1 data fee");
    const quote = guard.snapshot().transactions.find((candidate) => candidate.hash === probe.hash);
    if (!quote || quote.status !== "mined") throw new Error("The fee probe was not reconciled by the guard");
    const rawBytes = BigInt(quote.rawBytes);
    const l1FeePerByte = actual.l1Fee / rawBytes;
    if (actual.l1Fee > MAX_L1_FEE_PER_BYTE * rawBytes) throw new Error("The measured L1 data fee exceeds five times the reference rate");
    const oracleQuote = BigInt(quote.l1QuoteWei);
    if (actual.l1Fee > oracleQuote * 2n) throw new Error("The observed L1 fee and pre-broadcast oracle quote disagree");

    const output = {
      schemaVersion: "1.0",
      complete: true,
      status: "passed",
      network: hre.network.name,
      chainId: providerNetwork.chainId.toString(),
      quoteBlock,
      code: "USD",
      checkedAt: new Date().toISOString(),
      nodeVersion: process.version,
      hardhatVersion: hre.version,
      deployer: expectedDeployer,
      initialSharesCustody: expectedDeployer,
      source: network.source,
      bridgeLimitLocal: network.bridgeLimits.USD.toString(),
      rateEvidence: rateManifest.rates.find((candidate) => candidate.code === "USD"),
      feePolicy: {
        referenceL1FeePerByteWei: REFERENCE_L1_FEE_PER_BYTE.toString(),
        maximumL1FeePerByteWei: MAX_L1_FEE_PER_BYTE.toString(),
        maximumExecutionGasPriceWei: guard.maxGasPrice.toString(),
        maximumTransactionFeeWei: guard.maxTransactionFee.toString(),
        maximumTotalFeeWei: guard.maxTotalFee.toString(),
        l1QuoteMultiplier: "2",
        ordinaryTransactionCount: "9",
        ordinaryCalldataBytes: "512",
        ordinaryGasCeiling: ordinaryGasCeiling.toString(),
      },
      measuredProbe: {
        hash: probe.hash,
        rawBytes: rawBytes.toString(),
        totalFeeWei: actual.totalFee.toString(),
        l1FeeWei: actual.l1Fee.toString(),
        l2FeeWei: actual.l2Fee.toString(),
        l1FeePerByteWei: l1FeePerByte.toString(),
        preBroadcastOracleL1FeeWei: oracleQuote.toString(),
        explorer: `https://blockscout.testnet.dogeos.com/tx/${probe.hash}`,
      },
      plannedCreations: planned,
      ordinaryTransactionFeeAllowanceWei: ordinaryFee.toString(),
      conservativeRemainingPlanFeeWei: plannedFee.toString(),
      guard: guard.snapshot(),
    };
    writeJson(join(__dirname, "deployments/chikyuV2/USD_Preflight.json"), output);
    console.log(JSON.stringify(output, null, 2));
  } finally {
    guard.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
