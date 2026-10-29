import hre from "hardhat";
import "@nomicfoundation/hardhat-ethers";
import "hardhat-deploy";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Contract, Interface, parseEther, parseUnits, TransactionReceipt, ZeroAddress, getAddress, type Signer } from "ethers";
import { getTotalFeeGuard, TotalFeeGuard } from "../deployment/v2FeeGuard";
import { poolTickRange, positionCollateral, selectedCurrencies, sqrtPriceX96 } from "./demoMath";

interface DemoTokenConfig {
  symbol: string;
  name: string;
  priceNumerator: string;
  priceDenominator: string;
  poolSourceRaw: string;
  poolDemo: string;
}
interface PositionPlan { symbol: string; price: string; ratioPercent: number; initialCollateral: string }
interface RolloutConfig {
  network: string;
  chainId: string;
  owner: string;
  source: string;
  sourceDecimals: number;
  demoDecimals: number;
  feeCapTDOGE: string;
  transactionFeeCapTDOGE: string;
  maxL1FeePerByteTDOGE: string;
  newCurrencies: string[];
  allCurrencies: string[];
  bridgeTargetSource: string;
  bridgeTargetLocal: string;
  demoInitialSupply: string;
  barkswap: { factory: string; positionManager: string; tickLower: number; tickUpper: number; minOutputBips: number; deadlineSeconds: number };
  demoTokens: DemoTokenConfig[];
  positions: PositionPlan[];
  positionTerms: { capLocal: string; initPeriodSeconds: number; durationSeconds: number; challengePeriodSeconds: number; riskPremiumPPM: number; reservePPM: number };
  equityInvestments: Record<string, string>;
}
interface PositionRecord {
  code: string;
  collateralSymbol: string;
  address: string;
  openedTx: string;
  start: string;
  cooldown: string;
  expiration: string;
  capRaw: string;
  mintTx: string | null;
  usableQuoted?: string;
  actualBalanceDelta?: string;
}
interface EquityRecord {
  code: string;
  amountRaw: string;
  expectedShares: string;
  actualShares: string;
  investTx: string;
}
interface RolloutState {
  schemaVersion: string;
  network: string;
  chainId: string;
  owner: string;
  bridges: Record<string, { bridge: string; token: string; sourceLockedRaw: string; localMinted: string }>;
  demoTokens: Record<string, { address: string; deploymentTx: string }>;
  pools: Record<string, { address: string; tokenId: string; liquidity: string; priceX96: string }>;
  positions: PositionRecord[];
  equity: Record<string, EquityRecord>;
  fees?: unknown;
}

const root = join(__dirname, "../..");
const config = JSON.parse(readFileSync(join(root, "scripts/execution/demoRollout.config.json"), "utf8")) as RolloutConfig;
const statePath = join(root, "scripts/deployment/deployments/chikyuV2/demo-rollout-state.json");
const summaryPath = join(root, "scripts/deployment/deployments/chikyuV2/demo-rollout.json");
const mode = process.env.DEMO_MODE || "verify";
const stage = process.env.DEMO_STAGE || "all";
const pilot = process.env.DEMO_PILOT;
const erc20Abi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
];
const bridgeAbi = [
  "function usd() view returns (address)",
  "function ofd() view returns (address)",
  "function limit() view returns (uint256)",
  "function minted() view returns (uint256)",
  "function mint(uint256)",
];
const hubAbi = [
  "function openPosition(address,uint256,uint256,uint256,uint40,uint40,uint40,uint24,uint256,uint24) returns (address)",
  "event PositionOpened(address indexed owner,address indexed position,address original,address collateral)",
];
const positionAbi = [
  "function owner() view returns (address)",
  "function collateral() view returns (address)",
  "function price() view returns (uint256)",
  "function limit() view returns (uint256)",
  "function minted() view returns (uint256)",
  "function start() view returns (uint40)",
  "function cooldown() view returns (uint40)",
  "function expiration() view returns (uint40)",
  "function availableForMinting() view returns (uint256)",
  "function challengedAmount() view returns (uint256)",
  "function isClosed() view returns (bool)",
  "function getUsableMint(uint256,bool) view returns (uint256)",
  "function mint(address,uint256)",
];
const equityAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function calculateShares(uint256) view returns (uint256)",
  "function invest(uint256,uint256) returns (uint256)",
];
const factoryAbi = [
  "function createPool(address,address,bytes) returns (address)",
  "function poolByPair(address,address) view returns (address)",
];
const poolAbi = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function initialize(uint160)",
  "function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFee, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function tickSpacing() view returns (int24)",
];
const pmAbi = [
  "function mint((address token0,address token1,address deployer,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
  "function ownerOf(uint256) view returns (address)",
];
const hubInterface = new Interface(hubAbi);
const openedTopic = hubInterface.getEvent("PositionOpened")!.topicHash;

let guard: TotalFeeGuard;
let signer: Signer;
let owner: string;
let state: RolloutState;

function freshState(): RolloutState {
  return { schemaVersion: "1.0", network: config.network, chainId: config.chainId, owner: config.owner, bridges: {}, demoTokens: {}, pools: {}, positions: [], equity: {} };
}

function loadState(): RolloutState {
  if (!existsSync(statePath)) return freshState();
  const current = JSON.parse(readFileSync(statePath, "utf8")) as RolloutState;
  if (current.schemaVersion !== "1.0" || current.network !== config.network || current.chainId !== config.chainId || getAddress(current.owner) !== owner) throw new Error("Rollout state identity mismatch");
  current.equity ??= {};
  return current;
}

function saveState(): void {
  state.fees = guard.snapshot();
  mkdirSync(dirname(statePath), { recursive: true });
  for (const path of [statePath, summaryPath]) {
    const temporary = `${path}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n");
    renameSync(temporary, path);
  }
}

function contract(address: string, abi: string[], signed = false): Contract {
  return new Contract(getAddress(address), abi, signed ? signer : hre.ethers.provider) as Contract;
}

async function send(contract: Contract, method: string, args: unknown[], label: string): Promise<TransactionReceipt> {
  const fn = contract.getFunction(method);
  await fn.staticCall(...args);
  guard.labelNextTransaction(label.toLowerCase());
  const tx = await fn(...args);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${label} did not confirm successfully`);
  return receipt;
}

async function ensureAllowance(token: Contract, spender: string, amount: bigint, label: string): Promise<void> {
  if (amount <= 0n) return;
  if ((await token.allowance(owner, spender)) < amount) await send(token, "approve", [spender, amount], `${label}-approve`);
  if ((await token.allowance(owner, spender)) < amount) throw new Error(`${label}: exact allowance was not confirmed`);
}

async function ensureSource(amount: bigint): Promise<void> {
  const source = contract(config.source, erc20Abi, true);
  const balance = await source.balanceOf(owner);
  if (balance < amount) await send(source, "mint", [owner, amount - balance], "demo-source-mint");
  if ((await source.balanceOf(owner)) < amount) throw new Error("Source mint did not fund the deployer");
}

function registry(code: string): { code: string; addresses: Record<string, string>; sourceEvidence: { address: string } } {
  const path = join(root, `scripts/deployment/deployments/chikyuV2/${code}_V2Registry.json`);
  if (!existsSync(path)) throw new Error(`${code} V2 registry is missing; deploy the currency first`);
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  const current = artifact.linkedData ?? artifact;
  if (current.schemaVersion !== "2.0" || current.network !== config.network || current.chainId !== config.chainId || current.code !== code) throw new Error(`${code} registry identity mismatch`);
  if (getAddress(current.sourceEvidence.address) !== getAddress(config.source)) throw new Error(`${code} source mismatch`);
  return current;
}

async function bridgeStep(code: string): Promise<void> {
  const current = registry(code);
  const bridge = contract(current.addresses.Bridge, bridgeAbi, true);
  const source = contract(config.source, erc20Abi, true);
  const target = BigInt(config.bridgeTargetLocal);
  const targetSource = BigInt(config.bridgeTargetSource);
  if (getAddress(await bridge.usd()) !== getAddress(config.source) || getAddress(await bridge.ofd()) !== getAddress(current.addresses.Token)) throw new Error(`${code} bridge links mismatch`);
  const [minted, locked] = await Promise.all([bridge.minted(), source.balanceOf(current.addresses.Bridge)]);
  if (minted > target || locked > targetSource) throw new Error(`${code} bridge already exceeds the approved target`);
  if (minted === target && locked === targetSource) {
    state.bridges[code] = { bridge: current.addresses.Bridge, token: current.addresses.Token, sourceLockedRaw: locked.toString(), localMinted: minted.toString() };
    saveState();
    return;
  }
  if (mode !== "deploy") {
    console.log(JSON.stringify({ code, bridge: current.addresses.Bridge, localMinted: minted.toString(), targetLocal: target.toString(), sourceLocked: locked.toString(), targetSource: targetSource.toString() }));
    return;
  }
  const difference = target - minted;
  const sourceDifference = targetSource - locked;
  if (difference <= 0n || difference !== sourceDifference * 10n ** 12n) throw new Error(`${code} bridge local/source units are inconsistent`);
  await ensureSource(sourceDifference);
  await ensureAllowance(source, current.addresses.Bridge, sourceDifference, `${code}-bridge-fund`);
  await send(bridge, "mint", [sourceDifference], `${code}-bridge-fund`);
  if ((await bridge.minted()) !== target || (await source.balanceOf(current.addresses.Bridge)) !== targetSource) throw new Error(`${code} bridge target was not reached`);
  state.bridges[code] = { bridge: current.addresses.Bridge, token: current.addresses.Token, sourceLockedRaw: targetSource.toString(), localMinted: target.toString() };
  saveState();
}

async function demoTokenStep(tokenConfig: DemoTokenConfig): Promise<void> {
  const existing = state.demoTokens[tokenConfig.symbol];
  if (existing) {
    const token = contract(existing.address, erc20Abi);
    if ((await token.symbol()) !== tokenConfig.symbol || (await token.name()) !== tokenConfig.name || Number(await token.decimals()) !== config.demoDecimals) throw new Error(`${tokenConfig.symbol} recorded token metadata mismatch`);
    return;
  }
  if (mode !== "deploy") {
    console.log(JSON.stringify({ symbol: tokenConfig.symbol, status: "not-deployed" }));
    return;
  }
  const factory = await hre.ethers.getContractFactory("TestToken");
  const transaction = await factory.getDeployTransaction(tokenConfig.name, tokenConfig.symbol, config.demoDecimals);
  await hre.ethers.provider.estimateGas({ from: owner, data: transaction.data });
  guard.labelNextTransaction(`demo-${tokenConfig.symbol.toLowerCase()}-deploy`);
  const token = await factory.deploy(tokenConfig.name, tokenConfig.symbol, config.demoDecimals);
  const receipt = await token.deploymentTransaction()?.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${tokenConfig.symbol} deployment failed`);
  const address = await token.getAddress();
  if ((await token.symbol()) !== tokenConfig.symbol || (await token.name()) !== tokenConfig.name || Number(await token.decimals()) !== config.demoDecimals) throw new Error(`${tokenConfig.symbol} deployment metadata mismatch`);
  const supply = parseUnits(config.demoInitialSupply, config.demoDecimals);
  if ((await token.balanceOf(owner)) !== supply) throw new Error(`${tokenConfig.symbol} initial supply mismatch`);
  state.demoTokens[tokenConfig.symbol] = { address, deploymentTx: receipt.hash };
  saveState();
}

function poolTokenId(receipt: TransactionReceipt, positionManager: string): bigint {
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const matches = receipt.logs.filter((log) => getAddress(log.address) === getAddress(positionManager) && log.topics[0] === transferTopic && log.topics.length === 4 && BigInt(log.topics[1]) === 0n);
  if (matches.length !== 1) throw new Error("Expected one LP mint Transfer event");
  return BigInt(matches[0].topics[3]);
}

async function poolStep(tokenConfig: DemoTokenConfig): Promise<void> {
  const tokenRecord = state.demoTokens[tokenConfig.symbol];
  if (!tokenRecord) throw new Error(`${tokenConfig.symbol} must be deployed before its pool`);
  const recorded = state.pools[tokenConfig.symbol];
  const factory = contract(config.barkswap.factory, factoryAbi, true);
  let poolAddress = await factory.poolByPair(tokenRecord.address, config.source);
  if (poolAddress !== ZeroAddress && (!recorded || getAddress(recorded.address) !== getAddress(poolAddress))) throw new Error(`${tokenConfig.symbol} has an unrecorded existing pool`);
  if (!recorded && mode === "deploy" && poolAddress === ZeroAddress) {
    await send(factory, "createPool", [tokenRecord.address, config.source, "0x"], `pool-${tokenConfig.symbol.toLowerCase()}-create`);
    poolAddress = await factory.poolByPair(tokenRecord.address, config.source);
  }
  if (poolAddress === ZeroAddress) {
    console.log(JSON.stringify({ symbol: tokenConfig.symbol, status: "pool-not-created" }));
    return;
  }
  const pool = contract(poolAddress, poolAbi, true);
  const [token0, token1, currentState] = await Promise.all([pool.token0(), pool.token1(), pool.globalState()]);
  const decimals0 = Number(await contract(token0, erc20Abi).decimals());
  const decimals1 = Number(await contract(token1, erc20Abi).decimals());
  const sourceIsToken0 = getAddress(token0) === getAddress(config.source);
  const [priceNumerator, priceDenominator] = sourceIsToken0
    ? [tokenConfig.priceDenominator, tokenConfig.priceNumerator]
    : [tokenConfig.priceNumerator, tokenConfig.priceDenominator];
  const expectedPrice = sqrtPriceX96(decimals0, decimals1, priceNumerator, priceDenominator);
  if (currentState.price === 0n && mode === "deploy") await send(pool, "initialize", [expectedPrice], `pool-${tokenConfig.symbol.toLowerCase()}-initialize`);
  const initializedState = await pool.globalState();
  const spacing = await pool.tickSpacing();
  if (spacing <= 0n) throw new Error(`${tokenConfig.symbol} pool has no initialized tick spacing`);
  if (initializedState.price !== expectedPrice) throw new Error(`${tokenConfig.symbol} pool price mismatch: ${initializedState.price} != ${expectedPrice}`);
  if (recorded && (await pool.liquidity()) > 0n) {
    if (!recorded.tokenId || getAddress(await contract(config.barkswap.positionManager, pmAbi).ownerOf(BigInt(recorded.tokenId))) !== owner) throw new Error(`${tokenConfig.symbol} recorded LP ownership mismatch`);
    return;
  }
  if (mode !== "deploy") {
    console.log(JSON.stringify({ symbol: tokenConfig.symbol, pool: poolAddress, priceX96: expectedPrice.toString(), liquidity: (await pool.liquidity()).toString() }));
    return;
  }
  const sourceAmount = BigInt(tokenConfig.poolSourceRaw);
  const demoAmount = parseUnits(tokenConfig.poolDemo, config.demoDecimals);
  const positionManager = getAddress(config.barkswap.positionManager);
  await ensureSource(sourceAmount);
  await ensureAllowance(contract(config.source, erc20Abi, true), positionManager, sourceAmount, `pool-${tokenConfig.symbol.toLowerCase()}-source`);
  await ensureAllowance(contract(tokenRecord.address, erc20Abi, true), positionManager, demoAmount, `pool-${tokenConfig.symbol.toLowerCase()}-demo`);
  const amount0 = getAddress(token0) === getAddress(config.source) ? sourceAmount : demoAmount;
  const amount1 = getAddress(token0) === getAddress(config.source) ? demoAmount : sourceAmount;
  const { tickLower, tickUpper } = poolTickRange(config.barkswap.tickLower, config.barkswap.tickUpper, spacing);
  if (tickLower >= tickUpper) throw new Error(`${tokenConfig.symbol} has an empty tick range`);
  const block = await hre.ethers.provider.getBlock("latest");
  if (!block) throw new Error("Cannot obtain current chain timestamp");
  const params = {
    token0,
    token1,
    deployer: ZeroAddress,
    tickLower,
    tickUpper,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: amount0 * BigInt(config.barkswap.minOutputBips) / 10000n,
    amount1Min: amount1 * BigInt(config.barkswap.minOutputBips) / 10000n,
    recipient: owner,
    deadline: BigInt(block.timestamp + config.barkswap.deadlineSeconds),
  };
  const pm = contract(positionManager, pmAbi, true);
  const signature = "mint((address,address,address,int24,int24,uint256,uint256,uint256,uint256,address,uint256))";
  await pm.getFunction(signature).staticCall(params);
  const receipt = await send(pm, signature, [params], `pool-${tokenConfig.symbol.toLowerCase()}-mint`);
  const tokenId = poolTokenId(receipt, positionManager);
  if (getAddress(await pm.ownerOf(tokenId)) !== owner) throw new Error(`${tokenConfig.symbol} LP owner mismatch`);
  const liquidity = await pool.liquidity();
  if (liquidity <= 0n) throw new Error(`${tokenConfig.symbol} pool has no liquidity after mint`);
  state.pools[tokenConfig.symbol] = { address: getAddress(poolAddress), tokenId: tokenId.toString(), liquidity: liquidity.toString(), priceX96: expectedPrice.toString() };
  saveState();
}

async function openPosition(code: string, plan: PositionPlan): Promise<void> {
  const key = `${code}-${plan.symbol}`;
  const existing = state.positions.find((item) => item.code === code && item.collateralSymbol === plan.symbol);
  if (existing) {
    const position = contract(existing.address, positionAbi);
    if (getAddress(await position.owner()) !== owner || getAddress(await position.collateral()) !== getAddress(state.demoTokens[plan.symbol].address)) throw new Error(`${key} recorded position links mismatch`);
    return;
  }
  if (mode !== "deploy") {
    console.log(JSON.stringify({ key, status: "not-opened" }));
    return;
  }
  const tokenRecord = state.demoTokens[plan.symbol];
  if (!tokenRecord) throw new Error(`${plan.symbol} must be deployed before opening ${key}`);
  const current = registry(code);
  const hub = contract(current.addresses.MintingHub, hubAbi, true);
  const collateral = contract(tokenRecord.address, erc20Abi, true);
  const { priceRaw, capRaw, collateralRaw, minCollateralRaw } = positionCollateral(plan.price, plan.ratioPercent, config.positionTerms.capLocal);
  if (collateralRaw !== parseUnits(plan.initialCollateral, config.demoDecimals)) throw new Error(`${key} collateral does not match the approved ratio`);
  if ((await collateral.balanceOf(owner)) < collateralRaw) throw new Error(`${key} has insufficient collateral`);
  const local = contract(current.addresses.Token, erc20Abi);
  if ((await local.balanceOf(owner)) < parseEther("1000")) throw new Error(`${key} opening fee is not funded`);
  await ensureAllowance(collateral, current.addresses.MintingHub, collateralRaw, `${key}-collateral`);
  const args = [tokenRecord.address, minCollateralRaw, collateralRaw, capRaw, config.positionTerms.initPeriodSeconds, config.positionTerms.durationSeconds, config.positionTerms.challengePeriodSeconds, config.positionTerms.riskPremiumPPM, priceRaw, config.positionTerms.reservePPM];
  const receipt = await send(hub, "openPosition", args, `${key}-open`);
  const logs = receipt.logs.filter((log) => getAddress(log.address) === getAddress(current.addresses.MintingHub) && log.topics[0] === openedTopic);
  if (logs.length !== 1) throw new Error(`${key} expected one PositionOpened event`);
  const event = hubInterface.parseLog(logs[0]);
  if (!event) throw new Error(`${key} PositionOpened could not be decoded`);
  if (getAddress(event.args.owner) !== owner || getAddress(event.args.collateral) !== getAddress(tokenRecord.address)) throw new Error(`${key} event owner/collateral mismatch`);
  const positionAddress = getAddress(event.args.position);
  const position = contract(positionAddress, positionAbi);
  const [start, cooldown, expiration, minted, limit] = await Promise.all([position.start(), position.cooldown(), position.expiration(), position.minted(), position.limit()]);
  if (minted !== 0n || limit !== capRaw) throw new Error(`${key} initial position state mismatch`);
  state.positions.push({ code, collateralSymbol: plan.symbol, address: positionAddress, openedTx: receipt.hash, start: start.toString(), cooldown: cooldown.toString(), expiration: expiration.toString(), capRaw: capRaw.toString(), mintTx: null });
  saveState();
}

async function mintDue(record: PositionRecord, timestamp: number): Promise<void> {
  const position = contract(record.address, positionAbi, true);
  if (record.mintTx) {
    if ((await position.minted()) !== BigInt(record.capRaw)) throw new Error(`${record.code}/${record.collateralSymbol} mint receipt and current debt disagree`);
    return;
  }
  if ((await position.minted()) !== 0n) throw new Error(`${record.code}/${record.collateralSymbol} has unrecorded minted debt`);
  const [cooldown, expiration, challenged, closed, available] = await Promise.all([position.cooldown(), position.expiration(), position.challengedAmount(), position.isClosed(), position.availableForMinting()]);
  if (BigInt(timestamp) <= cooldown || BigInt(timestamp) >= expiration || challenged !== 0n || closed) return;
  const cap = BigInt(record.capRaw);
  if (available < cap) throw new Error(`${record.code}/${record.collateralSymbol} capacity changed before mint`);
  const current = registry(record.code);
  const local = contract(current.addresses.Token, erc20Abi);
  const before = await local.balanceOf(owner);
  const usable = await position.getUsableMint(cap, true);
  const receipt = await send(position, "mint", [owner, cap], `${record.code.toLowerCase()}-${record.collateralSymbol.toLowerCase()}-mint`);
  const after = await local.balanceOf(owner);
  if ((await position.minted()) !== cap || after <= before) throw new Error(`${record.code}/${record.collateralSymbol} mint postconditions failed`);
  record.mintTx = receipt.hash;
  record.usableQuoted = usable.toString();
  record.actualBalanceDelta = (after - before).toString();
  saveState();
}

async function equityStep(code: string): Promise<void> {
  const configuredAmount = config.equityInvestments[code];
  if (!configuredAmount) throw new Error(`${code} Equity investment is not configured`);
  const amount = parseEther(configuredAmount);
  if (amount <= 0n) throw new Error(`${code} Equity investment must be positive`);
  const current = registry(code);
  const local = contract(current.addresses.Token, erc20Abi);
  const equity = contract(current.addresses.Equity, equityAbi, true);
  const recorded = state.equity[code];
  if (recorded) {
    if (BigInt(recorded.amountRaw) !== amount || !recorded.investTx) throw new Error(`${code} Equity record does not match the configured scenario`);
    const [shareBalance, totalShares] = await Promise.all([equity.balanceOf(owner), equity.totalSupply()]);
    if (shareBalance < BigInt(recorded.actualShares) || totalShares < BigInt(recorded.actualShares)) throw new Error(`${code} Equity receipt and current shares disagree`);
    return;
  }
  const [beforeCurrency, beforeShares, beforeTotalShares, expectedShares] = await Promise.all([
    local.balanceOf(owner),
    equity.balanceOf(owner),
    equity.totalSupply(),
    equity.calculateShares(amount),
  ]);
  if (beforeCurrency < amount) throw new Error(`${code} has insufficient currency for the Equity scenario`);
  if (expectedShares <= 0n) throw new Error(`${code} Equity quote returned zero shares`);
  const receipt = await send(equity, "invest", [amount, expectedShares], `${code.toLowerCase()}-equity-invest`);
  const [afterCurrency, afterShares, afterTotalShares] = await Promise.all([local.balanceOf(owner), equity.balanceOf(owner), equity.totalSupply()]);
  const actualShares = afterShares - beforeShares;
  if (beforeCurrency - afterCurrency !== amount || actualShares < expectedShares || actualShares <= 0n || afterTotalShares - beforeTotalShares !== actualShares) throw new Error(`${code} Equity postconditions failed`);
  state.equity[code] = { code, amountRaw: amount.toString(), expectedShares: expectedShares.toString(), actualShares: actualShares.toString(), investTx: receipt.hash };
  saveState();
  console.log(JSON.stringify({ equityInvestment: code, amount: configuredAmount, expectedShares: expectedShares.toString(), actualShares: actualShares.toString(), transactionHash: receipt.hash }));
}

async function main(): Promise<void> {
  if (!process.versions.node.startsWith("20.")) throw new Error("Use Node 20 for the demo rollout");
  if (hre.network.name !== config.network || hre.network.config.chainId !== Number(config.chainId)) throw new Error("Wrong rollout network");
  if (process.env.IMF_V2_DEPLOYMENT_SCOPE !== "DEMO_ROLLOUT") throw new Error("Use DEMO_ROLLOUT scope");
  const named = await hre.getNamedAccounts();
  signer = await hre.ethers.getSigner(named.deployer);
  owner = getAddress(await signer.getAddress());
  if (owner !== getAddress(config.owner) || getAddress(process.env.IMF_V2_DEPLOYER ?? "") !== owner) throw new Error("Wrong rollout signer");
  guard = getTotalFeeGuard(hre.network.name);
  if (guard.maxTotalFee !== parseEther(config.feeCapTDOGE) || guard.maxTransactionFee !== parseEther(config.transactionFeeCapTDOGE) || guard.maxL1FeePerByte !== parseEther(config.maxL1FeePerByteTDOGE)) throw new Error("Unexpected fee cap");
  state = loadState();
  const currencies = selectedCurrencies(config.allCurrencies, pilot);
  try {
    const steps: Array<() => Promise<void>> = [];
    if (["all", "bridges"].includes(stage)) for (const code of config.allCurrencies) steps.push(() => bridgeStep(code));
    if (["all", "demo-tokens"].includes(stage)) for (const token of config.demoTokens) steps.push(() => demoTokenStep(token));
    if (["all", "pools"].includes(stage)) for (const token of config.demoTokens) steps.push(() => poolStep(token));
    if (["all", "positions"].includes(stage)) {
      if (mode === "deploy" && !pilot && !state.positions.some((position) => position.code === "EUR")) throw new Error("Run the EUR position pilot before the remaining positions");
      for (const code of currencies) for (const plan of config.positions) steps.push(() => openPosition(code, plan));
    }
    for (const step of steps) await step();
    if (mode === "mint-due") {
      if (!["all", "positions"].includes(stage)) throw new Error("mint-due requires the positions stage");
      const block = await hre.ethers.provider.getBlock("latest");
      if (!block) throw new Error("Cannot read the chain timestamp");
      for (const record of state.positions.filter((record) => currencies.includes(record.code))) await mintDue(record, block.timestamp);
    }
    if (mode === "invest") {
      if (stage !== "equity") throw new Error("invest requires the equity stage");
      for (const code of currencies) await equityStep(code);
    }
    const dueTimes = state.positions.filter((record) => !record.mintTx).map((record) => Number(record.cooldown) + 1);
    const output = {
      mode,
      stage,
      bridges: Object.keys(state.bridges).length,
      demoTokens: Object.keys(state.demoTokens).length,
      pools: Object.keys(state.pools).length,
      positions: state.positions.length,
      mintedPositions: state.positions.filter((record) => record.mintTx).length,
      equityInvestments: Object.keys(state.equity).length,
      nextMintDue: dueTimes.length ? new Date(Math.min(...dueTimes) * 1000).toISOString() : null,
      fees: guard.snapshot(),
    };
    saveState();
    console.log(JSON.stringify(output, null, 2));
  } finally {
    guard.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
