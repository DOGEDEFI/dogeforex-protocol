import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const REGISTRY_PATH = join(ROOT, 'deployments/k9usd.chikyu.json');
const OUTPUT_PATH = join(ROOT, 'deployments/chikyu.rehearsal-reconciliation.json');
const DEPLOYMENT_DIR = join(ROOT, 'scripts/deployment/deployments/chikyu');
const REG = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const RPC = process.env.RPC_URL_CHIKYU || REG.network?.rpc?.[0] || 'https://rpc.testnet.dogeos.com';
const CHAIN_ID = BigInt(REG.network?.chainId ?? 6281971);
const MAX_BLOCK_RANGE = 10000;
const PAUSE_TX = '0xcdfe9f9dd718cf0919d9109b4e359fdf46bf85c3247b849b5271efc171f8a012';
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const hubAbi = JSON.parse(readFileSync(join(ROOT, 'abi/MintingHub.json'), 'utf8'));
const positionAbi = JSON.parse(readFileSync(join(ROOT, 'abi/Position.json'), 'utf8'));
const erc20Abi = ['function balanceOf(address) view returns (uint256)'];
const tokenAbi = [
  'function guardian() view returns (address)',
  'function isMinter(address) view returns (bool)',
  'function minters(address) view returns (uint256)',
];
const guardianAbi = [
  'function paused() view returns (bool)',
  'function unpauseAvailableAt() view returns (uint256)',
  'event Paused(address indexed by)',
  'event UnpauseScheduled(address indexed by, uint256 availableAt)',
  'event Unpaused(address indexed by)',
];
const hubGateAbi = ['function admissionGuardianPaused() view returns (bool)'];

const contract = (address, abi) => new ethers.Contract(ethers.getAddress(address), abi, provider);
const stringify = (value) => typeof value === 'bigint' ? value.toString() : value;

async function queryChunked(target, filter, fromBlock, toBlock) {
  const events = [];
  for (let from = fromBlock; from <= toBlock; from += MAX_BLOCK_RANGE) {
    const to = Math.min(from + MAX_BLOCK_RANGE - 1, toBlock);
    events.push(...await target.queryFilter(filter, from, to));
  }
  return events;
}

function eventRecord(event, names) {
  const record = {
    transactionHash: event.transactionHash,
    blockNumber: event.blockNumber,
    logIndex: event.index,
  };
  for (const name of names) record[name] = stringify(event.args[name]);
  return record;
}

async function receiptRecord(hash) {
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) throw new Error(`Missing transaction receipt: ${hash}`);
  return { hash, status: receipt.status, blockNumber: receipt.blockNumber };
}

async function reconcileGuardian(latestBlock) {
  const instance = REG.instances.EUR;
  const address = instance.guardianTimelock?.address;
  if (!address) throw new Error('EUR guardian timelock address is missing');
  const guardian = contract(address, guardianAbi);
  const token = contract(instance.token.address, tokenAbi);
  const hub = contract(instance.mintingHub.address, hubGateAbi);
  const pauseReceipt = await receiptRecord(PAUSE_TX);
  const [paused, unpauseAvailableAt, tokenGuardian, hubAdmissionPaused] = await Promise.all([
    guardian.paused(),
    guardian.unpauseAvailableAt(),
    token.guardian(),
    hub.admissionGuardianPaused(),
  ]);
  const pauseEvents = await queryChunked(guardian, guardian.filters.Paused(), pauseReceipt.blockNumber, latestBlock);
  const scheduledEvents = await queryChunked(guardian, guardian.filters.UnpauseScheduled(), pauseReceipt.blockNumber, latestBlock);
  const unpauseEvents = await queryChunked(guardian, guardian.filters.Unpaused(), pauseReceipt.blockNumber, latestBlock);
  return {
    address,
    pauseReceipt,
    current: {
      paused,
      unpauseAvailableAt: stringify(unpauseAvailableAt),
      tokenGuardian,
      hubAdmissionPaused,
    },
    events: {
      paused: pauseEvents.map((event) => eventRecord(event, ['by'])),
      unpauseScheduled: scheduledEvents.map((event) => eventRecord(event, ['by', 'availableAt'])),
      unpaused: unpauseEvents.map((event) => eventRecord(event, ['by'])),
    },
    complete: pauseEvents.length > 0 && scheduledEvents.length > 0 && unpauseEvents.length > 0 && !paused && !hubAdmissionPaused,
  };
}

async function reconcilePosition(code, instance, latestBlock) {
  const rehearsal = instance.rehearsalPosition;
  const address = ethers.getAddress(rehearsal.position);
  const hubAddress = ethers.getAddress(instance.mintingHub.address);
  const position = contract(address, positionAbi);
  const hub = contract(hubAddress, hubAbi);
  const openReceipt = await receiptRecord(rehearsal.openTx);
  const fromBlock = openReceipt.blockNumber;
  const [mintEvents, startedEvents, succeededEvents, avertedEvents] = await Promise.all([
    queryChunked(position, position.filters.MintingUpdate(), fromBlock, latestBlock),
    queryChunked(hub, hub.filters.ChallengeStarted(null, address), fromBlock, latestBlock),
    queryChunked(hub, hub.filters.ChallengeSucceeded(address), fromBlock, latestBlock),
    queryChunked(hub, hub.filters.ChallengeAverted(address), fromBlock, latestBlock),
  ]);
  const [minted, challengedAmount, collateralAddress, price, cooldown, expiration, minimumCollateral] = await Promise.all([
    position.minted(),
    position.challengedAmount(),
    position.collateral(),
    position.price(),
    position.cooldown(),
    position.expiration(),
    position.minimumCollateral(),
  ]);
  const collateralBalance = await contract(collateralAddress, erc20Abi).balanceOf(address);
  const expectedMint = ethers.parseEther(String(rehearsal.prospectiveMint));
  const expectedChallengeSize = ethers.parseEther('4000');
  const expectedChallenger = ethers.getAddress(REG.roles.challenger);
  const started = startedEvents.map((event) => eventRecord(event, ['challenger', 'position', 'size', 'number']));
  const succeeded = succeededEvents.map((event) => eventRecord(event, ['position', 'number', 'bid', 'acquiredCollateral', 'challengeSize']));
  const averted = avertedEvents.map((event) => eventRecord(event, ['position', 'number', 'size']));
  const successfulNumbers = new Set(succeeded.map((event) => event.number));
  const avertedNumbers = new Set(averted.map((event) => event.number));
  const openChallengeNumbers = started
    .map((event) => event.number)
    .filter((number) => !successfulNumbers.has(number) && !avertedNumbers.has(number));
  const challenges = [];
  for (const event of started) {
    const current = await hub.challenges(event.number);
    challenges.push({
      number: event.number,
      challenger: current.challenger,
      start: stringify(current.start),
      position: current.position,
      size: stringify(current.size),
    });
  }
  const expectedMintObserved = mintEvents.some((event) => event.args.minted === expectedMint);
  const expectedChallengeObserved = started.some((event) =>
    ethers.getAddress(event.challenger) === expectedChallenger && BigInt(event.size) === expectedChallengeSize
  );
  const phaseOneComplete = expectedMintObserved && expectedChallengeObserved;
  const phaseTwoComplete = started.length > 0 && started.every((event) => successfulNumbers.has(event.number));
  return {
    position: address,
    hub: hubAddress,
    openReceipt,
    expected: {
      mint: expectedMint.toString(),
      challengeSize: expectedChallengeSize.toString(),
      challenger: expectedChallenger,
    },
    observed: {
      expectedMint: expectedMintObserved,
      expectedChallenge: expectedChallengeObserved,
      phaseOneComplete,
      phaseTwoComplete,
      status: started.length === 0 ? 'not-started' : openChallengeNumbers.length > 0 ? 'challenge-open' : phaseTwoComplete ? 'settled' : 'closed-without-full-settlement',
    },
    current: {
      minted: stringify(minted),
      challengedAmount: stringify(challengedAmount),
      collateral: collateralAddress,
      collateralBalance: stringify(collateralBalance),
      price: stringify(price),
      cooldown: stringify(cooldown),
      expiration: stringify(expiration),
      minimumCollateral: stringify(minimumCollateral),
      openChallengeNumbers,
      challenges,
    },
    events: {
      mintingUpdates: mintEvents.map((event) => eventRecord(event, ['collateral', 'price', 'minted'])),
      challengeStarted: started,
      challengeSucceeded: succeeded,
      challengeAverted: averted,
    },
  };
}

async function reconcileBridge(code, instance) {
  const artifactPath = join(DEPLOYMENT_DIR, `${code}_Bridge.json`);
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  const bridge = contract(artifact.address, artifact.abi);
  const token = contract(instance.token.address, tokenAbi);
  const [minted, limit, isMinter, validityStart] = await Promise.all([
    bridge.minted(),
    bridge.limit(),
    token.isMinter(artifact.address),
    token.minters(artifact.address),
  ]);
  return {
    bridge: ethers.getAddress(artifact.address),
    token: ethers.getAddress(instance.token.address),
    current: {
      minted: stringify(minted),
      limit: stringify(limit),
      isMinter,
      validityStart: stringify(validityStart),
    },
    status: minted > 0n ? 'observed-minted' : isMinter ? 'registered-without-mint' : validityStart > 0n ? 'application-pending' : 'not-registered',
  };
}

const network = await provider.getNetwork();
if (network.chainId !== CHAIN_ID) throw new Error(`Expected chain ${CHAIN_ID}, received ${network.chainId}`);
const latestBlock = await provider.getBlockNumber();
const latest = await provider.getBlock(latestBlock);
if (!latest) throw new Error(`Missing latest block ${latestBlock}`);
const guardian = await reconcileGuardian(latestBlock);
const positions = {};
for (const [code, instance] of Object.entries(REG.instances)) {
  if (instance.rehearsalPosition) positions[code] = await reconcilePosition(code, instance, latestBlock);
}
const bridges = {};
for (const [code, instance] of Object.entries(REG.instances)) bridges[code] = await reconcileBridge(code, instance);
const positionList = Object.values(positions);
const bridgeList = Object.values(bridges);
const evidence = {
  schemaVersion: '1.0',
  kind: 'dogeforex.v1-rehearsal-reconciliation',
  network: {
    name: REG.network.chainName,
    chainId: CHAIN_ID.toString(),
    rpc: RPC,
    blockNumber: latestBlock,
    blockTimestamp: latest.timestamp,
    blockTimestampIso: new Date(latest.timestamp * 1000).toISOString(),
    blockHash: latest.hash,
  },
  checkedAt: new Date().toISOString(),
  registry: 'k9usd.chikyu.json',
  readOnly: true,
  guardian,
  positions,
  bridges,
  summary: {
    guardianComplete: guardian.complete,
    rehearsalPositions: positionList.length,
    phaseOneComplete: positionList.filter((position) => position.observed.phaseOneComplete).length,
    phaseTwoComplete: positionList.filter((position) => position.observed.phaseTwoComplete).length,
    challengesOpen: positionList.filter((position) => position.observed.status === 'challenge-open').length,
    challengesNotStarted: positionList.filter((position) => position.observed.status === 'not-started').length,
    bridgesObservedMinted: bridgeList.filter((bridge) => bridge.status === 'observed-minted').length,
    bridgesNotRegistered: bridgeList.filter((bridge) => bridge.status === 'not-registered').length,
  },
};
const temporary = `${OUTPUT_PATH}.tmp-${process.pid}`;
writeFileSync(temporary, JSON.stringify(evidence, null, 2) + '\n');
renameSync(temporary, OUTPUT_PATH);
console.log(JSON.stringify({ output: OUTPUT_PATH, ...evidence.summary }, null, 2));
