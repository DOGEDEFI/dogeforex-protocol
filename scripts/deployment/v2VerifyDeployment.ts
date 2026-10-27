import hre from "hardhat";
import assert from "node:assert/strict";
import { getAddress, parseEther, parseUnits, ZeroAddress } from "ethers";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadInstances } from "./instanceConfig";
import { CHIKYU_CHAIN_ID, receiptTotalFee } from "./v2FeeGuard";

interface RegistryData {
  schemaVersion: string;
  network: string;
  chainId: string;
  code: string;
  addresses: Record<string, string>;
  constructorArgs: Record<string, unknown[]>;
  transactions: {
    deployments: Record<string, string | null>;
    initialize: Record<string, string>;
    sourceFunding: string | null;
    sourceApproval: string | null;
    bridgeMint: string | null;
    equityInvestment: string | null;
  };
  postconditions: Record<string, string | boolean>;
}

interface FeeRecord {
  hash: string;
  status: string;
  actualFeeWei?: string;
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n");
  renameSync(temporary, path);
}

function addressUrl(address: string): string {
  return `https://blockscout.testnet.dogeos.com/address/${address}#code`;
}

function transactionUrl(hash: string): string {
  return `https://blockscout.testnet.dogeos.com/tx/${hash}`;
}

async function main(): Promise<void> {
  if (!process.versions.node.startsWith("20.")) throw new Error("Use the repository's Node 20 runtime for Chikyu verification");
  assert.equal(hre.network.name, "chikyuV2");
  assert.equal((await hre.ethers.provider.getNetwork()).chainId, CHIKYU_CHAIN_ID);
  assert.equal(process.env.IMF_V2_DEPLOYMENT_SCOPE, "USD");
  const registry = (await hre.deployments.get("USD_V2Registry")).linkedData as RegistryData;
  assert.equal(registry.schemaVersion, "2.0");
  assert.equal(registry.network, hre.network.name);
  assert.equal(registry.chainId, CHIKYU_CHAIN_ID.toString());
  assert.equal(registry.code, "USD");
  assert.equal(registry.postconditions.complete, true);
  const addresses = registry.addresses;
  const instance = loadInstances().find((candidate) => candidate.code === "USD");
  assert.ok(instance);
  const deployer = getAddress(addresses.deployer);
  assert.equal(process.env.IMF_V2_DEPLOYER, deployer);
  assert.equal(deployer, getAddress(JSON.parse(readFileSync(join(__dirname, "../../deployments/k9usd.chikyu.json"), "utf8")).roles.deployer));
  assert.equal(addresses.GuardianTimelock, undefined);
  assert.equal(addresses.GenesisBootstrapSale, undefined);
  for (const label of ["source", "Token", "Equity", "PositionFactory", "PositionRoller", "Savings", "MintingHub", "Bridge"]) {
    const address = getAddress(addresses[label]);
    assert.notEqual(address, ZeroAddress);
    assert.notEqual(await hre.ethers.provider.getCode(address), "0x", `${label} has no bytecode`);
    addresses[label] = address;
  }

  const source = await hre.ethers.getContractAt("TestUSDC", addresses.source);
  const token = await hre.ethers.getContractAt("OracleFreeDollar", addresses.Token);
  const equity = await hre.ethers.getContractAt("Equity", addresses.Equity);
  const factory = await hre.ethers.getContractAt("PositionFactory", addresses.PositionFactory);
  const savings = await hre.ethers.getContractAt("Savings", addresses.Savings);
  const hub = await hre.ethers.getContractAt("MintingHub", addresses.MintingHub);
  const bridge = await hre.ethers.getContractAt("StablecoinBridge", addresses.Bridge);
  const local100 = parseEther("100");
  const source100 = parseUnits("100", 6);
  const initialShares = parseEther("1000");

  assert.equal(await token.reserve(), addresses.Equity);
  assert.equal(await token.name(), instance.tokenName);
  assert.equal(await token.symbol(), instance.tokenSymbol);
  assert.equal(await token.decimals(), 18n);
  assert.equal(await token.MIN_APPLICATION_PERIOD(), 900n);
  assert.equal(await token.MIN_FEE(), parseEther("1000"));
  assert.equal(await token.totalSupply(), local100);
  assert.equal(await token.minterReserve(), 0n);
  assert.equal(await token.equity(), local100);
  assert.equal(await token.balanceOf(addresses.Equity), local100);
  assert.equal(await token.balanceOf(deployer), 0n);
  assert.equal(token.interface.getFunction("guardian"), null);
  assert.equal(token.interface.getFunction("setGuardian"), null);
  assert.equal(hub.interface.getFunction("admissionGuardianPaused"), null);

  assert.equal(await equity.ofd(), addresses.Token);
  assert.equal(await equity.totalSupply(), initialShares);
  assert.equal(await equity.balanceOf(deployer), initialShares);
  assert.equal(await equity.price(), parseEther("0.3"));
  assert.equal(await savings.ofd(), addresses.Token);
  assert.equal(await savings.equity(), addresses.Equity);
  assert.equal(await savings.currentRatePPM(), BigInt(instance.leadratePPM));
  assert.equal(await savings.INTEREST_DELAY(), 259200n);
  assert.equal(await hub.ofd(), addresses.Token);
  assert.equal(await hub.rate(), addresses.Savings);
  assert.equal(await hub.roller(), addresses.PositionRoller);
  assert.equal(await hub.OPENING_FEE(), parseEther("1000"));
  assert.equal(await bridge.usd(), addresses.source);
  assert.equal(await bridge.ofd(), addresses.Token);
  assert.equal(await bridge.decimalMultiplier(), 10n ** 12n);
  assert.equal(await bridge.limit(), parseEther("1000000"));
  assert.equal(await bridge.minted(), local100);
  assert.equal(await source.name(), "Test USDC");
  assert.equal(await source.symbol(), "tUSDC");
  assert.equal(await source.decimals(), 6n);
  assert.equal(await source.deployer(), deployer);
  assert.equal(await source.totalSupply(), source100);
  assert.equal(await source.balanceOf(addresses.Bridge), source100);
  assert.equal(await source.balanceOf(deployer), 0n);

  const minters = [
    ["Savings", addresses.Savings],
    ["PositionFactory", addresses.PositionFactory],
    ["PositionRoller", addresses.PositionRoller],
    ["MintingHub", addresses.MintingHub],
    ["Bridge", addresses.Bridge],
  ] as const;
  const tokenDeployment = await hre.deployments.get("USD_Token");
  const deploymentBlock = tokenDeployment.receipt?.blockNumber;
  assert.ok(deploymentBlock);
  const latestBlock = await hre.ethers.provider.getBlockNumber();
  const minterApplied = token.filters.MinterApplied();
  const events = await token.queryFilter(minterApplied, deploymentBlock, Math.min(deploymentBlock + 9999, latestBlock));
  for (let fromBlock = deploymentBlock + 10000; fromBlock <= latestBlock; fromBlock += 10000) {
    events.push(...await token.queryFilter(minterApplied, fromBlock, Math.min(fromBlock + 9999, latestBlock)));
  }
  const genesis = events.filter((event) => "args" in event && event.args.applicationPeriod === 0n && event.args.applicationFee === 0n);
  assert.equal(genesis.length, 5);
  for (let index = 0; index < minters.length; index++) {
    const [key, address] = minters[index];
    assert.ok(await token.isMinter(address));
    assert.notEqual(await token.minters(address), 0n);
    const event = genesis[index];
    assert.ok("args" in event);
    assert.equal(getAddress(event.args.minter), address);
    assert.equal(event.transactionHash, registry.transactions.initialize[key]);
  }
  assert.equal(await token.isMinter(deployer), false);

  const expectedCalls: Array<[string, string | null, string, string?]> = [
    ["TestUSDC", registry.transactions.deployments.TestUSDC, ZeroAddress, addresses.source],
    ["USD_Token", registry.transactions.deployments.Token, ZeroAddress, addresses.Token],
    ["USD_PositionFactory", registry.transactions.deployments.PositionFactory, ZeroAddress, addresses.PositionFactory],
    ["USD_PositionRoller", registry.transactions.deployments.PositionRoller, ZeroAddress, addresses.PositionRoller],
    ["USD_Savings", registry.transactions.deployments.Savings, ZeroAddress, addresses.Savings],
    ["USD_MintingHub", registry.transactions.deployments.MintingHub, ZeroAddress, addresses.MintingHub],
    ["USD_Bridge", registry.transactions.deployments.Bridge, ZeroAddress, addresses.Bridge],
    ["TestUSDC funding", registry.transactions.sourceFunding, addresses.source],
    ["tUSDC approval", registry.transactions.sourceApproval, addresses.source],
    ["bridge mint", registry.transactions.bridgeMint, addresses.Bridge],
    ["equity investment", registry.transactions.equityInvestment, addresses.Equity],
  ];
  for (const [key, hash] of Object.entries(registry.transactions.initialize)) expectedCalls.push([key, hash, addresses.Token]);
  const receipts: Record<string, unknown> = {};
  for (const [label, hash, expectedTo, expectedContract] of expectedCalls) {
    assert.ok(hash, `${label} transaction hash is missing`);
    const receipt = await hre.ethers.provider.getTransactionReceipt(hash);
    assert.ok(receipt, `${label} receipt is missing`);
    assert.equal(receipt.status, 1, `${label} reverted`);
    assert.equal(getAddress(receipt.from), deployer);
    assert.equal(getAddress(receipt.to ?? ZeroAddress), expectedTo);
    if (expectedContract) assert.equal(receipt.contractAddress, expectedContract);
    const raw = (await hre.ethers.provider.send("eth_getTransactionReceipt", [hash])) as {
      gasUsed: string;
      effectiveGasPrice: string;
      l1Fee?: string;
    };
    const fee = receiptTotalFee(raw);
    receipts[label] = {
      hash,
      l1FeeWei: fee.l1Fee.toString(),
      l2FeeWei: fee.l2Fee.toString(),
      totalFeeWei: fee.totalFee.toString(),
      explorer: transactionUrl(hash),
    };
  }

  const positionArgs: [string, string, string, bigint, bigint, number, number, number, number, bigint, number] = [
    deployer,
    addresses.Token,
    addresses.source,
    parseUnits("3500", 6),
    parseEther("1000000"),
    259200,
    30 * 86400,
    86400,
    0,
    parseUnits("1", 30),
    200000,
  ];
  const shortArgs: typeof positionArgs = [...positionArgs];
  shortArgs[5] = 259199;
  await assert.rejects(factory.createNewPosition.staticCall(...shortArgs));
  const simulated = await factory.createNewPosition.staticCall(...positionArgs);
  assert.notEqual(getAddress(simulated), ZeroAddress);

  const feeState = JSON.parse(readFileSync(join(__dirname, "deployments/chikyuV2/feeGuard-USD.json"), "utf8")) as {
    network: string;
    chainId: string;
    scope: string;
    maxTotalFeeWei: string;
    spentFeeWei: string;
    transactions: Record<string, FeeRecord>;
  };
  assert.equal(feeState.network, "chikyuV2");
  assert.equal(feeState.chainId, CHIKYU_CHAIN_ID.toString());
  assert.equal(feeState.scope, "USD");
  let spent = 0n;
  for (const [hash, record] of Object.entries(feeState.transactions)) {
    assert.equal(record.hash, hash);
    assert.equal(record.status, "mined");
    assert.ok(record.actualFeeWei);
    const raw = (await hre.ethers.provider.send("eth_getTransactionReceipt", [hash])) as {
      gasUsed: string;
      effectiveGasPrice: string;
      l1Fee?: string;
    };
    assert.equal(record.actualFeeWei, receiptTotalFee(raw).totalFee.toString());
    spent += BigInt(record.actualFeeWei);
  }
  assert.equal(feeState.spentFeeWei, spent.toString());
  assert.ok(spent <= BigInt(feeState.maxTotalFeeWei));

  const outputPath = join(__dirname, "deployments/chikyuV2/USD_Verification.json");
  const evidence: Record<string, unknown> = {
    schemaVersion: "1.0",
    network: hre.network.name,
    chainId: CHIKYU_CHAIN_ID.toString(),
    code: "USD",
    checkedAt: new Date().toISOString(),
    complete: false,
    registry: "USD_V2Registry.json",
    addresses,
    links: Object.fromEntries(Object.entries(addresses).map(([label, address]) => [label, addressUrl(address)])),
    receipts,
    positionInitialization: {
      minimumSeconds: "259200",
      belowMinimumReverts: true,
      exactMinimumReadOnlyCallSucceeds: true,
      broadcast: false,
    },
    genesis: {
      minters: Object.fromEntries(minters),
      sourceLockedRaw: source100.toString(),
      localTokenSupply: local100.toString(),
      initialShares: initialShares.toString(),
      deployerInitialShares: initialShares.toString(),
      initialShareCustody: deployer,
      guardianOrAllocationMinterAPIs: false,
    },
    totalTrackedFeeWei: spent.toString(),
    maximumTrackedFeeWei: feeState.maxTotalFeeWei,
    contractVerification: [],
  };
  writeJson(outputPath, evidence);
  const contracts = [
    ["source", "TestUSDC", "contracts/test/TestUSDC.sol:TestUSDC"],
    ["Token", "Token", "contracts/OracleFreeDollar.sol:OracleFreeDollar"],
    ["Equity", "Equity", "contracts/Equity.sol:Equity"],
    ["PositionFactory", "PositionFactory", "contracts/PositionFactory.sol:PositionFactory"],
    ["PositionRoller", "PositionRoller", "contracts/PositionRoller.sol:PositionRoller"],
    ["Savings", "Savings", "contracts/Savings.sol:Savings"],
    ["MintingHub", "MintingHub", "contracts/MintingHub.sol:MintingHub"],
    ["Bridge", "Bridge", "contracts/StablecoinBridge.sol:StablecoinBridge"],
  ] as const;
  const sourcifyMatch = async (address: string): Promise<Record<string, unknown> | null> => {
    const url = `https://sourcify.dev/server/v2/contract/${CHIKYU_CHAIN_ID}/${address}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Sourcify lookup failed for ${address}: HTTP ${response.status}`);
    const match = (await response.json()) as Record<string, unknown>;
    return match.creationMatch === "exact_match" && match.runtimeMatch === "exact_match" ? match : null;
  };
  const verifySourcify = async (
    label: string,
    contract: string,
    address: string,
    creationTransactionHash: string
  ): Promise<Record<string, unknown>> => {
    const existing = await sourcifyMatch(address);
    if (existing) return existing;
    const sourceName = contract.split(":", 1)[0];
    const [stdJsonInput, build] = await Promise.all([
      hre.run("verify:etherscan-get-minimal-input", { sourceName }),
      hre.artifacts.getBuildInfo(contract),
    ]);
    assert.ok(build, `${label} has no compiler build information`);
    const response = await fetch(`https://sourcify.dev/server/v2/verify/${CHIKYU_CHAIN_ID}/${address}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stdJsonInput,
        compilerVersion: build.solcLongVersion,
        contractIdentifier: contract,
        creationTransactionHash,
      }),
      signal: AbortSignal.timeout(60000),
    });
    const submission = (await response.json()) as { verificationId?: string };
    if (!response.ok) throw new Error(`Sourcify ${label} submission failed: ${JSON.stringify(submission)}`);
    assert.ok(submission.verificationId, `Sourcify ${label} returned no verification ID`);
    let job: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 12; attempt++) {
      const jobResponse = await fetch(`https://sourcify.dev/server/v2/verify/${submission.verificationId}`, {
        signal: AbortSignal.timeout(20000),
      });
      job = (await jobResponse.json()) as Record<string, unknown>;
      if (!jobResponse.ok) throw new Error(`Sourcify ${label} job failed: ${JSON.stringify(job)}`);
      if (job.isJobCompleted === true) break;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    assert.equal(job.isJobCompleted, true, `Sourcify ${label} verification did not finish: ${JSON.stringify(job)}`);
    const match = await sourcifyMatch(address);
    assert.ok(match, `Sourcify ${label} did not produce an exact match: ${JSON.stringify(job)}`);
    return { ...match, verificationId: submission.verificationId };
  };
  const verification: Array<Record<string, unknown>> = [];
  for (const [key, label, contract] of contracts) {
    const creationTransactionHash = registry.transactions.deployments[label];
    assert.ok(creationTransactionHash, `${label} creation transaction is missing`);
    const sourcify = await verifySourcify(label, contract, addresses[key], creationTransactionHash);
    verification.push({
      label,
      address: addresses[key],
      contract,
      sourceUrl: addressUrl(addresses[key]),
      sourcify: {
        ...sourcify,
        apiUrl: `https://sourcify.dev/server/v2/contract/${CHIKYU_CHAIN_ID}/${addresses[key]}`,
      },
    });
    evidence.contractVerification = verification;
    writeJson(outputPath, evidence);
  }

  type BlockscoutSource = { is_verified?: boolean; name?: string; compiler_version?: string };
  type BlockscoutInspection = { httpStatus: number; source?: BlockscoutSource; error?: string };
  const blockscoutContract = async (address: string): Promise<BlockscoutInspection> => {
    try {
      const response = await fetch(`https://blockscout.testnet.dogeos.com/api/v2/smart-contracts/${address}`, {
        signal: AbortSignal.timeout(20000),
      });
      return {
        httpStatus: response.status,
        source: response.ok ? ((await response.json()) as BlockscoutSource) : undefined,
      };
    } catch (error) {
      return { httpStatus: 0, error: error instanceof Error ? error.message : String(error) };
    }
  };
  for (const record of verification) {
    const address = String(record.address);
    const inspected = await blockscoutContract(address);
    if (!inspected.source?.is_verified) {
      const contract = String(record.contract);
      const sourceName = contract.split(":", 1)[0];
      const contractName = contract.split(":")[1];
      const [stdJsonInput, build] = await Promise.all([
        hre.run("verify:etherscan-get-minimal-input", { sourceName }),
        hre.artifacts.getBuildInfo(contract),
      ]);
      assert.ok(build, `${String(record.label)} has no compiler build information`);
      assert.ok(contractName, `${String(record.label)} has no contract name`);
      const form = new FormData();
      form.append("compiler_version", `v${build.solcLongVersion}`);
      form.append("contract_name", contractName);
      form.append("license_type", "mit");
      form.append(
        "files[0]",
        new Blob([JSON.stringify(stdJsonInput)], { type: "application/json" }),
        "standard-input.json"
      );
      try {
        const response = await fetch(
          `https://blockscout.testnet.dogeos.com/api/v2/smart-contracts/${address}/verification/via/standard-input`,
          { method: "POST", body: form, signal: AbortSignal.timeout(60000) }
        );
        const body = await response.text();
        let submission: unknown = body.slice(0, 2000);
        try {
          submission = JSON.parse(body);
        } catch {
          submission = body.slice(0, 2000);
        }
        record.explorerSubmission = {
          method: "standard-input",
          submittedAt: new Date().toISOString(),
          httpStatus: response.status,
          response: submission,
        };
      } catch (error) {
        record.explorerSubmission = {
          method: "standard-input",
          submittedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        };
      }
      evidence.contractVerification = verification;
      writeJson(outputPath, evidence);
    }
  }
  const pending = new Set(verification);
  for (let attempt = 0; attempt < 12 && pending.size > 0; attempt++) {
    for (const record of pending) {
      const inspected = await blockscoutContract(String(record.address));
      const source = inspected.source;
      record.explorerVerified = source?.is_verified === true;
      record.explorerContractName = source?.name;
      record.explorerCompilerVersion = source?.compiler_version;
      record.explorerHttpStatus = inspected.httpStatus;
      if (inspected.error) record.explorerReadError = inspected.error;
      else delete record.explorerReadError;
      if (record.explorerVerified) pending.delete(record);
      evidence.contractVerification = verification;
      writeJson(outputPath, evidence);
    }
    if (attempt < 11 && pending.size > 0) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const blockers = verification
    .filter((record) => record.explorerVerified !== true)
    .map((record) => `${String(record.label)} is not verified on Blockscout`);
  evidence.sourceVerification = {
    requiredContracts: verification.length,
    sourcifyExactMatches: verification.filter((record) => {
      const sourcify = record.sourcify as Record<string, unknown>;
      return sourcify.creationMatch === "exact_match" && sourcify.runtimeMatch === "exact_match";
    }).length,
    blockscoutVerified: verification.filter((record) => record.explorerVerified === true).length,
  };
  evidence.blockers = blockers;
  evidence.complete = blockers.length === 0;
  evidence.checkedAt = new Date().toISOString();
  writeJson(outputPath, evidence);
  console.log(JSON.stringify(evidence, null, 2));
  assert.ok(evidence.complete, `Verification is incomplete: ${blockers.join("; ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
