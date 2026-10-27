import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction, Deployment, DeployResult } from "hardhat-deploy/types";
import { Contract, ContractTransactionResponse, getAddress, parseUnits, ZeroAddress } from "ethers";
import {
  deploymentName,
  InstanceConfig,
  loadInstances,
  minApplicationPeriodFor,
  selectInstances,
  validateInstances,
} from "../instanceConfig";
import { ApprovedSourceConfig, resolveNetworkConfig } from "../networkConfig";

const LOCAL_BOOTSTRAP = parseUnits("100", 18);
const INITIAL_SHARES = parseUnits("1000", 18);
const INITIAL_PRICE = parseUnits("0.3", 18);
const TEST_SOURCE_DEPLOYMENT = "TestUSDC";

const SOURCE_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
];

const BRIDGE_ABI = [
  "function usd() view returns (address)",
  "function ofd() view returns (address)",
  "function limit() view returns (uint256)",
  "function minted() view returns (uint256)",
  "function decimalMultiplier() view returns (uint256)",
  "function mint(uint256)",
];

interface RegistryTransactions {
  deployments: Record<string, string | null>;
  initialize: Record<string, string>;
  sourceFunding: string | null;
  sourceApproval: string | null;
  bridgeMint: string | null;
  equityInvestment: string | null;
}

interface RegistryData {
  schemaVersion: string;
  network: string;
  chainId: string;
  code: string;
  sourceEvidence: Record<string, unknown>;
  rateEvidence: unknown;
  constructorArgs: Record<string, unknown>;
  addresses: Record<string, string>;
  transactions: RegistryTransactions;
  postconditions: Record<string, string | boolean>;
}

function normalizeArgs(value: unknown): unknown {
  if (typeof value === "bigint" || typeof value === "number") return value.toString();
  if (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)) return value.toLowerCase();
  if (Array.isArray(value)) return value.map(normalizeArgs);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, normalizeArgs(entry)]));
  }
  return value;
}

function argsMatch(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(normalizeArgs(actual)) === JSON.stringify(normalizeArgs(expected));
}

function assertAddressEqual(actual: string, expected: string, label: string): void {
  let normalizedActual: string;
  let normalizedExpected: string;
  try {
    normalizedActual = getAddress(actual);
    normalizedExpected = getAddress(expected);
  } catch {
    throw new Error(`${label} contains an invalid address: actual=${actual}, expected=${expected}`);
  }
  if (normalizedActual === ZeroAddress || normalizedActual !== normalizedExpected) {
    throw new Error(`${label} address mismatch: actual=${actual}, expected=${expected}`);
  }
}

function assertEqual(actual: bigint, expected: bigint, label: string): void {
  if (actual !== expected) throw new Error(`${label} mismatch: actual=${actual}, expected=${expected}`);
}

function deploymentTransaction(deployment: Deployment): string | null {
  return deployment.transactionHash ?? deployment.receipt?.transactionHash ?? null;
}

function printable(value: unknown): string {
  return JSON.stringify(value, (_, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
}

async function waitFor(tx: ContractTransactionResponse, label: string): Promise<string> {
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} transaction failed: ${tx.hash}`);
  return tx.hash;
}

const deploy: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, ethers } = hre;
  const { deploy: deployContract, getOrNull, log } = deployments;
  const { deployer } = await getNamedAccounts();
  assertAddressEqual(deployer, deployer, "deployer");

  const instances = loadInstances();
  const rateManifest = validateInstances(instances);
  const providerNetwork = await ethers.provider.getNetwork();
  const configuredChainId = hre.network.config.chainId;
  if (configuredChainId !== undefined && providerNetwork.chainId !== BigInt(configuredChainId)) {
    throw new Error(`Hardhat config/provider chain ID mismatch: config=${configuredChainId}, provider=${providerNetwork.chainId}`);
  }
  const network = resolveNetworkConfig(hre.network.name, providerNetwork.chainId, instances, rateManifest.reviewStatus);
  const minApplicationPeriod = minApplicationPeriodFor(Number(network.chainId));
  const selectedInstances = selectInstances(hre, instances);
  const signer = await ethers.getSigner(deployer);

  const requireContract = async (address: string, label: string): Promise<void> => {
    assertAddressEqual(address, address, label);
    if ((await ethers.provider.getCode(address)) === "0x") {
      throw new Error(`${label} has no deployed bytecode at ${address} on ${network.name}`);
    }
  };

  const deployChecked = async (name: string, contract: string, args: unknown[] = []): Promise<DeployResult> => {
    const existing = await getOrNull(name);
    if (existing) {
      if (!existing.args || !argsMatch(existing.args, args)) {
        throw new Error(`${name} constructor arguments differ from the frozen v2 configuration`);
      }
      const difference = await deployments.fetchIfDifferent(name, {
        contract,
        from: deployer,
        args,
      });
      if (difference.differences) {
        throw new Error(`${name} existing bytecode differs from the current contract; refusing an implicit replacement`);
      }
    }
    const result = await deployContract(name, {
      contract,
      from: deployer,
      args,
      log: true,
      skipIfAlreadyDeployed: true,
    });
    if (existing) assertAddressEqual(result.address, existing.address, name);
    if (!result.args || !argsMatch(result.args, args)) throw new Error(`${name} did not record the expected constructor arguments`);
    await requireContract(result.address, name);
    return result;
  };

  let sourceAddress: string;
  let sharedSourceDeployment: Deployment | null = null;
  if (network.isTest) {
    sharedSourceDeployment = await deployChecked(TEST_SOURCE_DEPLOYMENT, "TestUSDC");
    sourceAddress = sharedSourceDeployment.address;
  } else {
    sourceAddress = (network.source as ApprovedSourceConfig).address;
    await requireContract(sourceAddress, `${network.name} approved source stablecoin`);
  }

  const source = new ethers.Contract(sourceAddress, SOURCE_ABI, signer) as Contract;
  await requireContract(sourceAddress, "source stablecoin");
  const sourceDecimals = Number(await source.decimals());
  if (!Number.isSafeInteger(sourceDecimals) || sourceDecimals < 0 || sourceDecimals > 18) {
    throw new Error(`Source stablecoin decimals must be an integer from 0 through 18; got ${sourceDecimals}`);
  }
  if (sourceDecimals !== network.source.decimals) {
    throw new Error(`Source decimals mismatch: config=${network.source.decimals}, on-chain=${sourceDecimals}`);
  }
  if (network.isTest) {
    if ((await source.symbol()) !== "tUSDC" || (await source.name()) !== "Test USDC") {
      throw new Error("Shared test source must be Test USDC with symbol tUSDC");
    }
  }
  const decimalMultiplier = 10n ** BigInt(18 - sourceDecimals);
  const sourceBootstrapRaw = parseUnits("100", sourceDecimals);
  assertEqual(sourceBootstrapRaw * decimalMultiplier, LOCAL_BOOTSTRAP, "source-to-local bootstrap conversion");

  const seenTokens = new Set<string>();
  const seenEquities = new Set<string>();
  const seenBridges = new Set<string>();

  for (const inst of selectedInstances) {
    log(`\n=== ${inst.code}: ${inst.tokenName} (${inst.tokenSymbol}) ===`);
    const names = {
      token: deploymentName(inst, "Token"),
      factory: deploymentName(inst, "PositionFactory"),
      roller: deploymentName(inst, "PositionRoller"),
      savings: deploymentName(inst, "Savings"),
      hub: deploymentName(inst, "MintingHub"),
      bridge: deploymentName(inst, "Bridge"),
      registry: deploymentName(inst, "V2Registry"),
    };
    const requiredDeployments = [names.token, names.factory, names.roller, names.savings, names.hub, names.bridge];
    const existingToken = await getOrNull(names.token);
    if (existingToken) {
      const existingTokenContract = await ethers.getContractAt("OracleFreeDollar", existingToken.address);
      const existingEquityContract = await ethers.getContractAt("Equity", await existingTokenContract.reserve());
      const existingSupplies = [await existingTokenContract.totalSupply(), await existingEquityContract.totalSupply()];
      if (existingSupplies.some((supply) => supply !== 0n)) {
        for (const name of requiredDeployments) {
          if (!(await getOrNull(name))) {
            throw new Error(`${inst.code} has supply but is missing ${name}; all modules and the bridge must predate supply`);
          }
        }
      }
    }

    const tokenArgs = [minApplicationPeriod, inst.tokenName, inst.tokenSymbol];
    const tokenDeployment = await deployChecked(names.token, "OracleFreeDollar", tokenArgs);
    const token = await ethers.getContractAt("OracleFreeDollar", tokenDeployment.address);
    const equityAddress = await token.reserve();
    await requireContract(equityAddress, `${inst.code} Equity reported by reserve()`);
    const equity = await ethers.getContractAt("Equity", equityAddress);
    if ((await token.name()) !== inst.tokenName) throw new Error(`${inst.code} token name mismatch`);
    if ((await token.symbol()) !== inst.tokenSymbol) throw new Error(`${inst.code} token symbol mismatch`);
    assertEqual(BigInt(await token.MIN_APPLICATION_PERIOD()), BigInt(minApplicationPeriod), `${inst.code} minimum application period`);
    assertEqual(BigInt(await token.decimals()), 18n, `${inst.code} token decimals`);
    assertEqual(BigInt(await equity.decimals()), 18n, `${inst.code} Equity decimals`);

    const factoryDeployment = await deployChecked(names.factory, "PositionFactory");
    const rollerArgs = [tokenDeployment.address];
    const rollerDeployment = await deployChecked(names.roller, "PositionRoller", rollerArgs);
    const savingsArgs = [tokenDeployment.address, inst.leadratePPM];
    const savingsDeployment = await deployChecked(names.savings, "Savings", savingsArgs);
    const hubArgs = [tokenDeployment.address, savingsDeployment.address, rollerDeployment.address, factoryDeployment.address];
    const hubDeployment = await deployChecked(names.hub, "MintingHub", hubArgs);
    const bridgeLimit = network.bridgeLimits[inst.code];
    if (bridgeLimit === undefined) throw new Error(`Missing reviewed bridge limit for ${inst.code}`);
    const bridgeArgs = [sourceAddress, tokenDeployment.address, bridgeLimit];
    const bridgeDeployment = await deployChecked(names.bridge, "StablecoinBridge", bridgeArgs);
    const bridge = new ethers.Contract(bridgeDeployment.address, BRIDGE_ABI, signer) as Contract;

    const savings = await ethers.getContractAt("Savings", savingsDeployment.address);
    const hub = await ethers.getContractAt("MintingHub", hubDeployment.address);
    assertAddressEqual(await savings.ofd(), tokenDeployment.address, `${inst.code} Savings token`);
    assertAddressEqual(await savings.equity(), equityAddress, `${inst.code} Savings Equity`);
    assertEqual(BigInt(await savings.currentRatePPM()), BigInt(inst.leadratePPM), `${inst.code} initial leadrate`);
    assertAddressEqual(await hub.ofd(), tokenDeployment.address, `${inst.code} MintingHub token`);
    assertAddressEqual(await hub.rate(), savingsDeployment.address, `${inst.code} MintingHub leadrate`);
    assertAddressEqual(await hub.roller(), rollerDeployment.address, `${inst.code} MintingHub roller`);
    assertAddressEqual(await bridge.usd(), sourceAddress, `${inst.code} bridge source`);
    assertAddressEqual(await bridge.ofd(), tokenDeployment.address, `${inst.code} bridge token`);
    assertEqual(BigInt(await bridge.limit()), bridgeLimit, `${inst.code} bridge limit`);
    assertEqual(BigInt(await bridge.decimalMultiplier()), decimalMultiplier, `${inst.code} bridge decimal multiplier`);

    for (const [label, address] of [
      ["token", tokenDeployment.address],
      ["Equity", equityAddress],
      ["PositionFactory", factoryDeployment.address],
      ["PositionRoller", rollerDeployment.address],
      ["Savings", savingsDeployment.address],
      ["MintingHub", hubDeployment.address],
      ["bridge", bridgeDeployment.address],
    ] as Array<[string, string]>) {
      await requireContract(address, `${inst.code} ${label}`);
    }

    const tokenKey = tokenDeployment.address.toLowerCase();
    const equityKey = equityAddress.toLowerCase();
    const bridgeKey = bridgeDeployment.address.toLowerCase();
    if (seenTokens.has(tokenKey) || seenEquities.has(equityKey) || seenBridges.has(bridgeKey)) {
      throw new Error(`${inst.code} reused a token, Equity, or bridge address from another currency`);
    }
    seenTokens.add(tokenKey);
    seenEquities.add(equityKey);
    seenBridges.add(bridgeKey);

    const rateEvidence = rateManifest.rates.find((evidence) => evidence.code === inst.code);
    if (!rateEvidence) throw new Error(`Missing rate evidence for ${inst.code}`);
    const previousRegistry = (await getOrNull(names.registry))?.linkedData as Partial<RegistryData> | undefined;
    if (previousRegistry) {
      if (
        previousRegistry.schemaVersion !== "2.0" ||
        previousRegistry.network !== network.name ||
        previousRegistry.chainId !== network.chainId.toString() ||
        previousRegistry.code !== inst.code
      ) {
        throw new Error(`${inst.code} existing v2 registry identity mismatch`);
      }
      if (previousRegistry.rateEvidence && !argsMatch(previousRegistry.rateEvidence, rateEvidence)) {
        throw new Error(`${inst.code} rate evidence changed after deployment`);
      }
    }

    const constructorArgs = {
      TestUSDC: network.isTest ? [] : undefined,
      Token: tokenArgs,
      Equity: [tokenDeployment.address, inst.tokenName, inst.tokenSymbol],
      PositionFactory: [],
      PositionRoller: rollerArgs,
      Savings: savingsArgs,
      MintingHub: hubArgs,
      Bridge: bridgeArgs,
    };
    const addresses = {
      deployer,
      source: sourceAddress,
      Token: tokenDeployment.address,
      Equity: equityAddress,
      PositionFactory: factoryDeployment.address,
      PositionRoller: rollerDeployment.address,
      Savings: savingsDeployment.address,
      MintingHub: hubDeployment.address,
      Bridge: bridgeDeployment.address,
    };
    if (previousRegistry?.addresses) {
      for (const [label, address] of Object.entries(addresses)) {
        const previousAddress = previousRegistry.addresses[label];
        if (previousAddress) assertAddressEqual(previousAddress, address, `${inst.code} registry ${label}`);
      }
    }
    if (previousRegistry?.constructorArgs && !argsMatch(previousRegistry.constructorArgs, constructorArgs)) {
      throw new Error(`${inst.code} constructor registry differs from the current deployment`);
    }

    const registryData: RegistryData = {
      schemaVersion: "2.0",
      network: network.name,
      chainId: network.chainId.toString(),
      code: inst.code,
      sourceEvidence: {
        ...network.source,
        address: sourceAddress,
        onchainDecimals: sourceDecimals.toString(),
        decimalMultiplier: decimalMultiplier.toString(),
        bytecodeValidated: true,
        fundingMode: network.isTest ? "deployer-only test faucet" : "existing approved deployer balance",
      },
      rateEvidence,
      constructorArgs: normalizeArgs(constructorArgs) as Record<string, unknown>,
      addresses,
      transactions: {
        deployments: {
          ...(previousRegistry?.transactions?.deployments ?? {}),
          TestUSDC: sharedSourceDeployment
            ? deploymentTransaction(sharedSourceDeployment) ?? previousRegistry?.transactions?.deployments.TestUSDC ?? null
            : null,
          Token: deploymentTransaction(tokenDeployment) ?? previousRegistry?.transactions?.deployments.Token ?? null,
          Equity:
            deploymentTransaction(tokenDeployment) ?? previousRegistry?.transactions?.deployments.Equity ?? null,
          PositionFactory:
            deploymentTransaction(factoryDeployment) ?? previousRegistry?.transactions?.deployments.PositionFactory ?? null,
          PositionRoller:
            deploymentTransaction(rollerDeployment) ?? previousRegistry?.transactions?.deployments.PositionRoller ?? null,
          Savings: deploymentTransaction(savingsDeployment) ?? previousRegistry?.transactions?.deployments.Savings ?? null,
          MintingHub:
            deploymentTransaction(hubDeployment) ?? previousRegistry?.transactions?.deployments.MintingHub ?? null,
          Bridge: deploymentTransaction(bridgeDeployment) ?? previousRegistry?.transactions?.deployments.Bridge ?? null,
        },
        initialize: { ...(previousRegistry?.transactions?.initialize ?? {}) },
        sourceFunding: previousRegistry?.transactions?.sourceFunding ?? null,
        sourceApproval: previousRegistry?.transactions?.sourceApproval ?? null,
        bridgeMint: previousRegistry?.transactions?.bridgeMint ?? null,
        equityInvestment: previousRegistry?.transactions?.equityInvestment ?? null,
      },
      postconditions: { ...(previousRegistry?.postconditions ?? {}), complete: false },
    };
    const saveRegistry = async (): Promise<void> => {
      const lastTransaction =
        registryData.transactions.equityInvestment ??
        registryData.transactions.bridgeMint ??
        registryData.transactions.sourceApproval ??
        registryData.transactions.sourceFunding ??
        registryData.transactions.deployments.Bridge ??
        undefined;
      await deployments.save(names.registry, {
        address: tokenDeployment.address,
        abi: [],
        transactionHash: lastTransaction ?? undefined,
        linkedData: registryData,
      });
    };
    await saveRegistry();

    const registrations = [
      { key: "Savings", address: savingsDeployment.address, label: "Savings" },
      { key: "PositionFactory", address: factoryDeployment.address, label: "Position Factory" },
      { key: "PositionRoller", address: rollerDeployment.address, label: "Position Roller" },
      { key: "MintingHub", address: hubDeployment.address, label: "Minting Hub V2" },
      { key: "Bridge", address: bridgeDeployment.address, label: "Source Stablecoin Bridge" },
    ];
    const requireZeroSupplies = async (): Promise<void> => {
      const tokenSupply = await token.totalSupply();
      const shareSupply = await equity.totalSupply();
      if (tokenSupply !== 0n || shareSupply !== 0n) {
        throw new Error(`${inst.code} initialize is forbidden after supply exists: token=${tokenSupply}, shares=${shareSupply}`);
      }
    };

    for (const registration of registrations) {
      assertAddressEqual(registration.address, registration.address, `${inst.code} ${registration.key}`);
      await requireContract(registration.address, `${inst.code} ${registration.key} minter`);
      const validityStart = await token.minters(registration.address);
      if (validityStart === 0n) {
        await requireZeroSupplies();
        const tx = await token.initialize(registration.address, registration.label);
        registryData.transactions.initialize[registration.key] = await waitFor(tx, `${inst.code} initialize ${registration.key}`);
        await saveRegistry();
        log(`${inst.code} initialized ${registration.key}`);
      }
      if ((await token.minters(registration.address)) === 0n || !(await token.isMinter(registration.address))) {
        throw new Error(`${inst.code} ${registration.key} is not an active genesis minter`);
      }
    }

    const deploymentBlock = tokenDeployment.receipt?.blockNumber ?? 0;
    const minterEvents = await token.queryFilter(token.filters.MinterApplied(), deploymentBlock, "latest");
    const genesisMinters: string[] = [];
    for (const event of minterEvents) {
      if (!("args" in event) || !event.args) throw new Error(`${inst.code} has an undecodable MinterApplied event`);
      if (BigInt(event.args.applicationPeriod) === 0n && BigInt(event.args.applicationFee) === 0n) {
        genesisMinters.push(getAddress(event.args.minter));
      }
    }
    if (genesisMinters.length !== registrations.length) {
      throw new Error(`${inst.code} must have exactly five genesis MinterApplied events; found ${genesisMinters.length}`);
    }
    for (let index = 0; index < registrations.length; index++) {
      assertAddressEqual(genesisMinters[index], registrations[index].address, `${inst.code} genesis minter ${index + 1}`);
    }

    const readState = async () => ({
      tokenSupply: await token.totalSupply(),
      shareSupply: await equity.totalSupply(),
      deployerShares: await equity.balanceOf(deployer),
      deployerLocal: await token.balanceOf(deployer),
      equityLocal: await token.balanceOf(equityAddress),
      minterReserve: await token.minterReserve(),
      equityValue: await token.equity(),
      price: await equity.price(),
      bridgeMinted: await bridge.minted(),
      sourceLocked: await source.balanceOf(bridgeDeployment.address),
    });

    const isFresh = (state: Awaited<ReturnType<typeof readState>>): boolean =>
      state.tokenSupply === 0n &&
      state.shareSupply === 0n &&
      state.deployerShares === 0n &&
      state.deployerLocal === 0n &&
      state.equityLocal === 0n &&
      state.minterReserve === 0n &&
      state.equityValue === 0n &&
      state.bridgeMinted === 0n &&
      state.sourceLocked === 0n;

    const isBridgeMinted = (state: Awaited<ReturnType<typeof readState>>): boolean =>
      state.tokenSupply === LOCAL_BOOTSTRAP &&
      state.shareSupply === 0n &&
      state.deployerShares === 0n &&
      state.deployerLocal === LOCAL_BOOTSTRAP &&
      state.equityLocal === 0n &&
      state.minterReserve === 0n &&
      state.equityValue === 0n &&
      state.bridgeMinted === LOCAL_BOOTSTRAP &&
      state.sourceLocked === sourceBootstrapRaw;

    const isComplete = (state: Awaited<ReturnType<typeof readState>>): boolean =>
      state.tokenSupply === LOCAL_BOOTSTRAP &&
      state.shareSupply === INITIAL_SHARES &&
      state.deployerShares === INITIAL_SHARES &&
      state.deployerLocal === 0n &&
      state.equityLocal === LOCAL_BOOTSTRAP &&
      state.minterReserve === 0n &&
      state.equityValue === LOCAL_BOOTSTRAP &&
      state.price === INITIAL_PRICE &&
      state.bridgeMinted === LOCAL_BOOTSTRAP &&
      state.sourceLocked === sourceBootstrapRaw;

    let state = await readState();
    if (!isFresh(state) && !isBridgeMinted(state) && !isComplete(state)) {
      throw new Error(`${inst.code} unrecognized or mismatched bootstrap state: ${printable(state)}`);
    }

    if (isFresh(state)) {
      const deployerSourceBalance = await source.balanceOf(deployer);
      if (deployerSourceBalance < sourceBootstrapRaw) {
        if (!network.isTest) {
          throw new Error(
            `${inst.code} production deployer has ${deployerSourceBalance} source raw units; ${sourceBootstrapRaw} are required and no test mint is allowed`
          );
        }
        const tx = await source.mint(deployer, sourceBootstrapRaw - deployerSourceBalance);
        registryData.transactions.sourceFunding = await waitFor(tx, `${inst.code} TestUSDC funding`);
        await saveRegistry();
      }
      if ((await source.balanceOf(deployer)) < sourceBootstrapRaw) {
        throw new Error(`${inst.code} deployer source funding did not reach ${sourceBootstrapRaw} raw units`);
      }
      if ((await source.allowance(deployer, bridgeDeployment.address)) < sourceBootstrapRaw) {
        const tx = await source.approve(bridgeDeployment.address, sourceBootstrapRaw);
        registryData.transactions.sourceApproval = await waitFor(tx, `${inst.code} source approval`);
        await saveRegistry();
      }

      state = await readState();
      if (!isFresh(state) || state.shareSupply !== 0n) {
        throw new Error(`${inst.code} state changed before bridge mint: ${printable(state)}`);
      }
      const mintTx = await bridge.mint(sourceBootstrapRaw);
      registryData.transactions.bridgeMint = await waitFor(mintTx, `${inst.code} bridge mint`);
      await saveRegistry();
      state = await readState();
      if (!isBridgeMinted(state)) {
        throw new Error(`${inst.code} bridge mint postconditions failed: ${printable(state)}`);
      }
      registryData.postconditions.sourceLockedRaw = state.sourceLocked.toString();
      registryData.postconditions.localMinted = state.tokenSupply.toString();
      registryData.postconditions.bridgeMintedLocal = state.bridgeMinted.toString();
      registryData.postconditions.zeroSharesBeforeInvestment = true;
      await saveRegistry();
    }

    if (isBridgeMinted(state)) {
      state = await readState();
      if (!isBridgeMinted(state) || state.shareSupply !== 0n) {
        throw new Error(`${inst.code} state changed before Equity investment: ${printable(state)}`);
      }
      const returnedShares = await equity.invest.staticCall(LOCAL_BOOTSTRAP, INITIAL_SHARES);
      assertEqual(BigInt(returnedShares), INITIAL_SHARES, `${inst.code} shares returned by initial investment`);
      const investTx = await equity.invest(LOCAL_BOOTSTRAP, INITIAL_SHARES);
      registryData.transactions.equityInvestment = await waitFor(investTx, `${inst.code} Equity investment`);
      await saveRegistry();
      state = await readState();
    }

    if (!isComplete(state)) throw new Error(`${inst.code} final bootstrap postconditions failed: ${printable(state)}`);
    assertEqual(BigInt(await savings.currentRatePPM()), BigInt(inst.leadratePPM), `${inst.code} final leadrate`);
    registryData.postconditions = {
      ...registryData.postconditions,
      complete: true,
      exactlyFiveGenesisMinters: true,
      sourceLockedRaw: state.sourceLocked.toString(),
      localTokenSupply: state.tokenSupply.toString(),
      bridgeMintedLocal: state.bridgeMinted.toString(),
      initialShares: state.shareSupply.toString(),
      deployerInitialShares: state.deployerShares.toString(),
      equityTokenBalance: state.equityLocal.toString(),
      minterReserve: state.minterReserve.toString(),
      equity: state.equityValue.toString(),
      price: state.price.toString(),
      initialLeadratePPM: inst.leadratePPM.toString(),
    };
    await saveRegistry();
    log(
      `${inst.code} complete: sourceLocked=${state.sourceLocked} raw, equity=${state.equityValue}, shares=${state.shareSupply}, price=${state.price}`
    );
  }
};

export default deploy;
deploy.tags = ["00_deploy_all", ...loadInstances().map((instance) => instance.code)];
deploy.dependencies = [];
