// DogeForex P2 — K9USD pools + scripted positions + equity tranche 2 (Chikyu, chain 6281971)
// Staged + resumable. Every mutating call is staticCall-validated first. Aborts on unexpected revert.
// Keys are loaded programmatically and never printed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const RPC = 'https://rpc.testnet.dogeos.com';
const CHAIN_ID = 6281971;
const STATE_FILE = '/Users/tonicaradonna/.dogeforex/p2-state.json';

// ---- addresses (EIP-55 re-validated at startup) ----
const A = {
  k9usd: '0x7cd12A6C4CbcfE87af588d9c3FF8576aB4FBF5A8',
  equity: '0x61B9193ef708972D694f98DbBF2dA9ccfD614C4E',
  hub: '0x0bADA8D887573Cc47eBef4ff5BBE42942B580F9b',
  mofx: '0x2F0393CEb21b040722D36b628DB2C75aB0E0b156',
  wuff: '0x03538800942cF78fb59550532496164D1d3bE31D',
  wdogeCustom: '0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE', // Barkswap WNativeToken
  wdogeCanon: '0x5300000000000000000000000000000000000004', // canonical predeploy (positions)
  factory: '0xF3961157f56C983316657f0267B4C04460beE43f',
  pm: '0xf596329a6c7E03F0708199cB5435f86783DB4302',
  router: '0x911E5A1630fD1768E5A1710DAAFaBb865cB79531',
  wuffDeployer: '0xB3b792aF28412722348D95EC19266805dd5B71f6',
};
for (const [k, v] of Object.entries(A)) A[k] = ethers.getAddress(v); // throws on bad checksum

// ---- keys (never printed) ----
const keys = JSON.parse(readFileSync('/Users/tonicaradonna/.dogeforex/keys.json', 'utf8'));
const pk = (role) => {
  const k = keys.roles[role]?.privateKey;
  if (!k) throw new Error('missing key role ' + role);
  return k;
};
const noiseEnv = readFileSync('/Users/tonicaradonna/sixr-doge-noise/.env', 'utf8');
const wuffDeployerPk = noiseEnv.split('\n').find((l) => l.startsWith('PRIVATE_KEYS=')).slice('PRIVATE_KEYS='.length).split(',')[0].trim();

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const w = {
  treasury: new ethers.Wallet(pk('treasury'), provider),
  deployer: new ethers.Wallet(pk('deployer'), provider),
  wuffDeployer: new ethers.Wallet(wuffDeployerPk, provider),
};
if (w.wuffDeployer.address !== A.wuffDeployer) throw new Error('WUFF deployer key/address mismatch');

// ---- ABIs ----
const ABI = {
  erc20: ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)'],
  wdoge: ['function deposit() payable', 'function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'],
  mofx: ['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function decimals() view returns (uint8)'],
  factory: ['function createPool(address,address,bytes) returns (address)', 'function poolByPair(address,address) view returns (address)'],
  pool: ['function token0() view returns (address)', 'function token1() view returns (address)', 'function initialize(uint160)', 'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFee, bool unlocked)', 'function liquidity() view returns (uint128)', 'function tickSpacing() view returns (int24)'],
  pm: ['function mint((address token0, address token1, address deployer, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'],
  hub: ['function openPosition(address,uint256,uint256,uint256,uint40,uint40,uint40,uint24,uint256,uint24) returns (address)', 'function OPENING_FEE() view returns (uint256)', 'event PositionOpened(address indexed owner, address indexed position, address original, address collateral)'],
  position: ['function mint(address,uint256)', 'function minted() view returns (uint256)', 'function price() view returns (uint256)', 'function collateral() view returns (address)', 'function minimumCollateral() view returns (uint256)', 'function mintingMaximum() view returns (uint256)', 'function owner() view returns (address)', 'function start() view returns (uint40)', 'function expiration() view returns (uint256)'],
  ofd: ['function minterReserve() view returns (uint256)', 'function equity() view returns (uint256)', 'function totalSupply() view returns (uint256)'],
  equity: ['function calculateShares(uint256) view returns (uint256)', 'function invest(uint256,uint256) returns (uint256)', 'function totalSupply() view returns (uint256)', 'function price() view returns (uint256)', 'function balanceOf(address) view returns (uint256)'],
};
const C = (addr, abi, signer) => new ethers.Contract(addr, abi, signer ?? provider);

// ---- run state ----
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { stages: {}, results: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const done = (k) => state.stages[k]?.done === true;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmtE = (v) => ethers.formatEther(v);

// Total fee incl. L1 data fee: ethers' parsed receipt drops the chain-specific
// l1Fee field, so re-fetch the raw receipt (OPS-02: v1 read receipt.fee = L2
// execution fee only and passed at 0.00x baseline — WRONG; same fix as p3/p4).
async function totalFee(rc) {
  const raw = await provider.send('eth_getTransactionReceipt', [rc.hash]);
  const l2 = BigInt(raw.gasUsed) * BigInt(raw.effectiveGasPrice);
  const l1 = raw.l1Fee ? BigInt(raw.l1Fee) : 0n;
  return l1 + l2;
}

function isqrt(y) {
  if (y < 0n) throw new Error('isqrt neg');
  let x = y, z = (y + 1n) / 2n;
  while (z < x) { x = z; z = (z + y / z) / 2n; }
  return x;
}
const Q96 = 1n << 96n;
const priceQ96fromRatioE18 = (ratioE18) => isqrt((ratioE18 << 192n) / 10n ** 18n); // sqrt(ratio)*2^96

// fee regime (runbook §1.1): probe per-byte rate; abort if > 2x baseline 0.000071
let feeRate = null;
async function feePreflight() {
  if (done('feePreflight')) { feeRate = state.stages.feePreflight.rate; return; }
  log('STAGE feePreflight: probe L1 per-byte fee with a 0-value K9USD transfer (~110B calldata)');
  const t = C(A.k9usd, ABI.erc20, w.treasury);
  await t.transfer.staticCall(w.deployer.address, 0n);
  const tx = await t.transfer(w.deployer.address, 0n);
  const rc = await tx.wait(1);
  const bytes = (tx.data.length - 2) / 2;
  const rate = Number(fmtE(await totalFee(rc))) / bytes;
  const ratio = rate / 0.000071;
  log(`  probe: ${bytes} calldata bytes, total fee ${fmtE(await totalFee(rc))} DOGE => ${rate.toFixed(6)} DOGE/B (ratio ${ratio.toFixed(2)}x baseline)`);
  if (ratio > 2) throw new Error(`FEE REGIME SHIFT: ${ratio.toFixed(2)}x baseline > 2x — abort per runbook §1.1`);
  state.stages.feePreflight = { done: true, rate, tx: tx.hash };
  save();
  feeRate = rate;
}

async function guarded(wallet, contract, method, args, opts, label, expectFeeBytes) {
  await contract[method].staticCall(...args, opts); // revert => throw
  const tx = await contract[method](...args, opts);
  const rc = await tx.wait(1);
  const bytes = tx.data.length / 2 - 1;
  const expected = 0.011 + feeRate * ((expectFeeBytes ?? bytes) - 110);
  const fee = Number(fmtE(await totalFee(rc)));
  if (fee > 3 * expected) throw new Error(`${label}: total fee ${fee} > 3x expected ${expected.toFixed(4)} — halt`);
  log(`  ${label}: ok tx=${rc.hash} totalFee=${fee.toFixed(4)}`);
  return rc;
}

async function ensureAllowance(wallet, token, spender, amount, label) {
  const t = C(token, ABI.erc20, wallet);
  if ((await t.allowance(wallet.address, spender)) >= amount) { log(`  ${label}: allowance ok`); return; }
  await guarded(wallet, t, 'approve', [spender, ethers.MaxUint256], {}, label + ' approve');
}

async function stage(name, fn) {
  if (done(name)) { log('SKIP (done):', name); return state.stages[name].result; }
  log('STAGE:', name);
  const result = await fn();
  state.stages[name] = { done: true, result };
  save();
  log('  ->', JSON.stringify(result));
  return result;
}

// ---- sizing (P2, testnet-scaled; see deviations in report) ----
const SIZES = {
  deployerToTreasuryDoge: ethers.parseEther('2.5'),
  mofxMintToTreasury: ethers.parseUnits('13700', 18), // 13,200 collateral + 500 ref pool
  wuffToTreasury: ethers.parseUnits('50000', 18),
  wrapCustom: ethers.parseEther('5.0'),
  wrapCanon: ethers.parseEther('4.0'),
  starWdoge: ethers.parseEther('5.0'),
  starK9usd: ethers.parseUnits('0.425', 18), // 5.0 * 0.085 K9USD/wDOGE (§0.4 rate)
  refMofx: ethers.parseUnits('500', 18),
  refK9usd: ethers.parseUnits('500', 18),
  equityInvest: ethers.parseUnits('19000', 18),
};
const DAY = 86400n;

// =========================================================================
try {
  log('treasury', w.treasury.address, '| deployer', w.deployer.address, '| wuffDeployer', w.wuffDeployer.address);
  await feePreflight();

  // S-19 light: record bot balances (read-only)
  await stage('S19_botBalances', async () => {
    const out = {};
    for (const n of ['challenger', 'keeper', 'searcher', 'minter-bank', 'denybot', 'watcher']) out[n] = fmtE(await provider.getBalance(pkAddr(n)));
    function pkAddr(n) { return keys.roles[n].address; }
    return out;
  });

  // 1) deployer -> treasury 2.5 tDOGE (so treasury can wrap both pool + position wDOGE and stay >= 2 tDOGE)
  await stage('fundTreasury', async () => {
    const tx = await w.deployer.sendTransaction({ to: w.treasury.address, value: SIZES.deployerToTreasuryDoge });
    const rc = await tx.wait(1);
    log('  deployer->treasury 2.5 tDOGE tx=', rc.hash, 'totalFee=', fmtE(await totalFee(rc)));
    return { tx: rc.hash, treasuryDoge: fmtE(await provider.getBalance(w.treasury.address)) };
  });

  // 2) MOFX mint (deployer-gated)
  await stage('mofxMint', async () => {
    const m = C(A.mofx, ABI.mofx, w.deployer);
    const rc = await guarded(w.deployer, m, 'mint', [w.treasury.address, SIZES.mofxMintToTreasury], {}, 'MOFX.mint(treasury,13700)');
    const bal = await C(A.mofx, ABI.erc20).balanceOf(w.treasury.address);
    if (bal < SIZES.mofxMintToTreasury) throw new Error('MOFX balance assert failed');
    return { tx: rc.hash, treasuryMofx: fmtE(bal) };
  });

  // 3) WUFF transfer from noise deployer
  await stage('wuffTransfer', async () => {
    const t = C(A.wuff, ABI.erc20, w.wuffDeployer);
    const rc = await guarded(w.wuffDeployer, t, 'transfer', [w.treasury.address, SIZES.wuffToTreasury], {}, 'WUFF.transfer(treasury,50k)');
    const bal = await t.balanceOf(w.treasury.address);
    if (bal < SIZES.wuffToTreasury) throw new Error('WUFF balance assert failed');
    return { tx: rc.hash, treasuryWuff: fmtE(bal) };
  });

  // 4) wraps
  const wrapRes = {};
  await stage('wrapCustom', async () => {
    const wd = C(A.wdogeCustom, ABI.wdoge, w.treasury);
    const rc = await guarded(w.treasury, wd, 'deposit', [], { value: SIZES.wrapCustom }, 'custom wDOGE deposit(5)');
    return { tx: rc.hash, bal: fmtE(await wd.balanceOf(w.treasury.address)) };
  });
  await stage('wrapCanon', async () => {
    const wd = C(A.wdogeCanon, ABI.wdoge, w.treasury);
    if (Number(await wd.decimals()) !== 18) throw new Error('canonical wDOGE decimals != 18');
    const rc = await guarded(w.treasury, wd, 'deposit', [], { value: SIZES.wrapCanon }, 'canonical wDOGE deposit(4)');
    return { tx: rc.hash, bal: fmtE(await wd.balanceOf(w.treasury.address)) };
  });

  // 5) star pool K9USD / custom wDOGE, full range
  await stage('starPool', async () => {
    const f = C(A.factory, ABI.factory, w.treasury);
    let pool = await f.poolByPair(A.k9usd, A.wdogeCustom);
    if (pool === ethers.ZeroAddress) {
      const rc = await guarded(w.treasury, f, 'createPool', [A.k9usd, A.wdogeCustom, '0x'], {}, 'star createPool');
      pool = await f.poolByPair(A.k9usd, A.wdogeCustom);
      log('  star pool created:', pool);
    }
    const p = C(pool, ABI.pool, w.treasury);
    const t0 = await p.token0(); const t1 = await p.token1();
    let gs = await p.globalState();
    if (gs.price === 0n) {
      // token0=K9USD, token1=wDOGE (address sort). Algebra price = sqrt(token1/token0) = sqrt(wDOGE per K9USD)
      const ratioE18 = (SIZES.starWdoge * 10n ** 18n) / SIZES.starK9usd; // wDOGE per K9USD (~11.7647e18)
      const price = priceQ96fromRatioE18(ratioE18);
      await guarded(w.treasury, p, 'initialize', [price], {}, 'star initialize');
      gs = await p.globalState();
    }
    await ensureAllowance(w.treasury, A.k9usd, A.pm, SIZES.starK9usd, 'K9USD->PM');
    await ensureAllowance(w.treasury, A.wdogeCustom, A.pm, SIZES.starWdoge, 'wDOGE->PM');
    const pm = C(A.pm, ABI.pm, w.treasury);
    const k9Is0 = t0.toLowerCase() === A.k9usd.toLowerCase();
    const amt0 = k9Is0 ? SIZES.starK9usd : SIZES.starWdoge;
    const amt1 = k9Is0 ? SIZES.starWdoge : SIZES.starK9usd;
    const params = { token0: t0, token1: t1, deployer: ethers.ZeroAddress, tickLower: -887220, tickUpper: 887220, amount0Desired: amt0, amount1Desired: amt1, amount0Min: 0n, amount1Min: 0n, recipient: w.treasury.address, deadline: Math.floor(Date.now() / 1000) + 1800 };
    let tokenId, liquidity, mintTx;
    if ((await p.liquidity()) > 0n) {
      // mint already executed by an earlier partial run — recover the LP NFT id from that mint receipt
      const RECOVER_TX = '0x909238ef609e78f42526040196efd7dd0d66b14dfac48c8b837eece467f55eb0';
      const rcOld = await provider.getTransactionReceipt(RECOVER_TX);
      if (!rcOld) throw new Error('star pool has liquidity but recovery tx not found');
      const topic0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // ERC721 Transfer
      const transferLog = rcOld.logs.find((l) => l.address.toLowerCase() === A.pm.toLowerCase() && l.topics[0] === topic0 && l.topics[2].toLowerCase() === '0x000000000000000000000000' + w.treasury.address.slice(2).toLowerCase());
      if (!transferLog) throw new Error('could not recover LP tokenId from mint receipt');
      tokenId = BigInt(transferLog.topics[3]).toString();
      liquidity = (await p.liquidity()).toString();
      mintTx = RECOVER_TX;
      log('  star mint already done (recovered tokenId', tokenId, 'from', RECOVER_TX, ')');
    } else {
      const sim = await pm.mint.staticCall(params);
      const rc = await guarded(w.treasury, pm, 'mint', [params], {}, 'star mint', 1500);
      tokenId = sim[0].toString(); liquidity = sim[1].toString(); mintTx = rc.hash;
    }
    const gs2 = await p.globalState();
    // implied K9USD per wDOGE
    const ratio2 = (BigInt(gs2.price) * BigInt(gs2.price) * 10n ** 18n) >> 192n; // token1/token0
    const implied = k9Is0 ? (10n ** 36n) / ratio2 : ratio2; // K9USD per wDOGE
    const impliedNum = Number(fmtE(implied));
    log('  star globalState price=', gs2.price.toString(), ' implied K9USD/wDOGE=', impliedNum);
    if (Math.abs(impliedNum - 0.085) / 0.085 > 0.2) throw new Error(`star pool price ${impliedNum} outside 20% of 0.085 — orientation wrong, abort`);
    return { pool, token0: t0, token1: t1, tokenId, liquidity, tx: mintTx, sizes: { k9usd: fmtE(k9Is0 ? amt0 : amt1), wdoge: fmtE(k9Is0 ? amt1 : amt0) }, globalStatePrice: gs2.price.toString(), impliedK9usdPerWdoge: impliedNum };
  });

  // 6) MOFX/K9USD reference pool, ~par +/-1% band
  await stage('refPool', async () => {
    const f = C(A.factory, ABI.factory, w.treasury);
    let pool = await f.poolByPair(A.mofx, A.k9usd);
    if (pool === ethers.ZeroAddress) {
      await guarded(w.treasury, f, 'createPool', [A.mofx, A.k9usd, '0x'], {}, 'ref createPool');
      pool = await f.poolByPair(A.mofx, A.k9usd);
    }
    const p = C(pool, ABI.pool, w.treasury);
    const t0 = await p.token0(); const t1 = await p.token1();
    let gs = await p.globalState();
    if (gs.price === 0n) await guarded(w.treasury, p, 'initialize', [Q96], {}, 'ref initialize(par)'); // sqrt(1.0)*2^96
    const spacing = Number(await p.tickSpacing());
    const tickLower = Math.floor(-51 / spacing) * spacing;
    const tickUpper = Math.ceil(51 / spacing) * spacing;
    await ensureAllowance(w.treasury, A.mofx, A.pm, SIZES.refMofx, 'MOFX->PM');
    await ensureAllowance(w.treasury, A.k9usd, A.pm, SIZES.refK9usd, 'K9USD->PM(ref)');
    const pm = C(A.pm, ABI.pm, w.treasury);
    const amt0 = t0.toLowerCase() === A.mofx.toLowerCase() ? SIZES.refMofx : SIZES.refK9usd;
    const amt1 = t0.toLowerCase() === A.mofx.toLowerCase() ? SIZES.refK9usd : SIZES.refMofx;
    const params = { token0: t0, token1: t1, deployer: ethers.ZeroAddress, tickLower, tickUpper, amount0Desired: amt0, amount1Desired: amt1, amount0Min: 0n, amount1Min: 0n, recipient: w.treasury.address, deadline: Math.floor(Date.now() / 1000) + 1800 };
    let tokenId, liquidity, mintTx;
    if ((await p.liquidity()) > 0n) {
      const logs = await provider.getLogs({ address: A.pm, fromBlock: (await provider.getBlockNumber()) - 5000, toBlock: 'latest', topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', null, '0x000000000000000000000000' + w.treasury.address.slice(2).toLowerCase()] });
      const last = logs[logs.length - 1];
      tokenId = BigInt(last.topics[3]).toString();
      liquidity = (await p.liquidity()).toString();
      mintTx = last.transactionHash;
      log('  ref mint already done (recovered tokenId', tokenId, 'from', mintTx, ')');
    } else {
      const sim = await pm.mint.staticCall(params);
      const rc = await guarded(w.treasury, pm, 'mint', [params], {}, 'ref mint', 1500);
      tokenId = sim[0].toString(); liquidity = sim[1].toString(); mintTx = rc.hash;
    }
    const gs2 = await p.globalState();
    const rawRatio = (BigInt(gs2.price) * BigInt(gs2.price)) >> 192n; // token1/token0 (dimensionless)
    const mofxPerK9 = t0.toLowerCase() === A.mofx.toLowerCase() ? (10n ** 36n / rawRatio) / 10n ** 18n : rawRatio * 10n ** 18n; // MOFX per K9USD, 18-dec
    const par = Number(fmtE(mofxPerK9));
    log('  ref globalState price=', gs2.price.toString(), ' implied MOFX/K9USD=', par, ' ticks', tickLower, tickUpper);
    if (Math.abs(par - 1.0) > 0.01) throw new Error(`ref pool par ${par} outside 1% — abort`);
    return { pool, token0: t0, token1: t1, tokenId, liquidity, tx: mintTx, sizes: { mofx: fmtE(SIZES.refMofx), k9usd: fmtE(SIZES.refK9usd) }, globalStatePrice: gs2.price.toString(), impliedMofxPerK9usd: par, ticks: [tickLower, tickUpper], tickSpacing: spacing };
  });

  // 7) positions
  const positionsOut = [];
  const reserveBefore = await C(A.k9usd, ABI.ofd).minterReserve();
  const POS = [
    // contract bounds honored: liqPrice*minCollateral <= mintingMaximum (Position.sol:330) and
    // minCollateral*liqPrice >= 3500e36 (MintingHub.sol:151); runbook min/max values that violate these are adjusted.
    { name: 'P1-conservative', coll: A.mofx, min: ethers.parseUnits('4000', 18), init: ethers.parseUnits('6000', 18), max: ethers.parseUnits('4000', 18), dur: 60n * DAY, risk: 20000n, liq: ethers.parseUnits('1.000', 18), res: 200000n, mint: ethers.parseUnits('3500', 18) },
    { name: 'P2-degen', coll: A.mofx, min: ethers.parseUnits('3500', 18), init: ethers.parseUnits('3600', 18), max: ethers.parseUnits('3500', 18), dur: 30n * DAY, risk: 50000n, liq: ethers.parseUnits('1.000', 18), res: 100000n, mint: ethers.parseUnits('3100', 18) },
    { name: 'P3-arena-bait', coll: A.mofx, min: ethers.parseUnits('3600', 18), init: ethers.parseUnits('3600', 18), max: ethers.parseUnits('3600', 18), dur: 21n * DAY, risk: 100000n, liq: ethers.parseUnits('0.98', 18), res: 50000n, mint: ethers.parseUnits('3399', 18) },
    { name: 'wDOGE-conservative', coll: A.wdogeCanon, min: ethers.parseUnits('3.5', 18), init: ethers.parseUnits('4.0', 18), max: ethers.parseUnits('3500', 18), dur: 60n * DAY, risk: 20000n, liq: ethers.parseUnits('1000', 18), res: 200000n, mint: ethers.parseUnits('2666', 18) },
    { name: 'WUFF-150', coll: A.wuff, min: ethers.parseUnits('50', 18), init: ethers.parseUnits('100', 18), max: ethers.parseUnits('4700', 18), dur: 60n * DAY, risk: 20000n, liq: ethers.parseUnits('70', 18), res: 200000n, mint: ethers.parseUnits('4666', 18) },
  ];
  await stage('positions', async () => {
    const hub = C(A.hub, ABI.hub, w.treasury);
    const RECOVER = {
      // P1 opened in a previous partial run (mint never executed); recover instead of re-opening
      'P1-conservative': { position: '0xc7b71A7E4F79b9118Bee8072E79fD7A321ca341b', openTx: '0x45b6f3bd2f205f8da9e3a973fada664168e3f8dd7e8de49be4b14e6c03d516d8' },
    };
    state.progress = state.progress || {};
    state.progress.positions = state.progress.positions || [];
    for (const p of POS) {
      const existing = state.progress.positions.find((x) => x.name === p.name);
      if (existing) { log(`  ${p.name}: already done (recovered)`); positionsOut.push(existing); continue; }
      await ensureAllowance(w.treasury, p.coll, A.hub, p.init, p.name + ' coll->hub');
      let posAddr, openTx;
      if (RECOVER[p.name]) {
        posAddr = RECOVER[p.name].position; openTx = RECOVER[p.name].openTx;
        log(`  ${p.name}: recovered existing position ${posAddr}`);
      } else {
        // staticCall validation (includes hub floor + collateral revert-check)
        await hub.openPosition.staticCall(p.coll, p.min, p.init, p.max, 5n * DAY, p.dur, 1n * DAY, p.risk, p.liq, p.res);
        const rc = await guarded(w.treasury, hub, 'openPosition', [p.coll, p.min, p.init, p.max, 5n * DAY, p.dur, 1n * DAY, p.risk, p.liq, p.res], {}, p.name + ' openPosition', 1300);
        const ev = rc.logs.map((l) => { try { return hub.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'PositionOpened');
        if (!ev) throw new Error(p.name + ': PositionOpened not found');
        posAddr = ev.args.position; openTx = rc.hash;
      }
      const pos = C(posAddr, ABI.position, w.treasury);
      // mint — impossible during the initPeriod deny window (Position.sol: cooldown=start => Hot());
      // defer to P2b with mintableAt recorded instead of aborting the line.
      let mintTx = null, mintDeferred = false;
      const startTs = Number(await pos.start());
      if ((await pos.minted()) === 0n) {
        try {
          await pos.mint.staticCall(w.treasury.address, p.mint);
          const mrc = await guarded(w.treasury, pos, 'mint', [w.treasury.address, p.mint], {}, p.name + ' mint');
          mintTx = mrc.hash;
        } catch (e) {
          const isHot = String(e.data ?? '').startsWith('0x700a083c') || String(e.reason ?? '').includes('Hot');
          if (!isHot) throw e;
          mintDeferred = true;
          log(`  ${p.name}: mint deferred (Hot() — mintable at ${new Date(startTs * 1000).toISOString()})`);
        }
      }
      // verifies
      const minted = await pos.minted();
      if (!mintDeferred && minted !== p.mint) throw new Error(`${p.name}: minted ${minted} != ${p.mint}`);
      const colBal = await C(p.coll, ABI.erc20).balanceOf(posAddr);
      const px = await pos.price();
      const cr = Number((colBal * px * 10000n) / ((minted > 0n ? minted : p.mint) * 10n ** 18n)) / 100;
      if (minted > 0n && colBal * px < minted * 10n ** 18n) throw new Error(p.name + ': collateral*liqPrice < minted');
      const owner = await pos.owner();
      if (owner.toLowerCase() !== w.treasury.address.toLowerCase()) throw new Error(p.name + ': owner mismatch');
      log(`  ${p.name}: pos=${posAddr} minted=${fmtE(minted)} CR=${(cr * 100).toFixed(1)}%${mintDeferred ? ' (prospective)' : ''}`);
      const rec = { name: p.name, position: posAddr, collateral: p.coll, initialCollateral: fmtE(p.init), liqPrice: fmtE(p.liq), minted: fmtE(minted), mintDeferred, mintableAt: new Date(startTs * 1000).toISOString(), prospectiveMint: fmtE(p.mint), crPercent: Number((cr * 100).toFixed(2)), openTx, mintTx };
      positionsOut.push(rec);
      state.progress.positions.push(rec);
      save();
    }
    const reserveAfter = await C(A.k9usd, ABI.ofd).minterReserve();
    const anyMinted = positionsOut.some((x) => !x.mintDeferred);
    if (anyMinted && reserveAfter <= reserveBefore) throw new Error('minterReserve did not increase');
    log('  minterReserve', fmtE(reserveBefore), '->', fmtE(reserveAfter), anyMinted ? '' : '(all mints deferred — reserve unchanged as expected)');
    return { positions: positionsOut, minterReserveBefore: fmtE(reserveBefore), minterReserveAfter: fmtE(reserveAfter), mintingDeferred: !anyMinted };
  });

  // 8) equity tranche 2
  await stage('equityTranche2', async () => {
    const eq = C(A.equity, ABI.equity);
    const preview = await eq.calculateShares(SIZES.equityInvest);
    await ensureAllowance(w.treasury, A.k9usd, A.equity, SIZES.equityInvest, 'K9USD->Equity');
    const balBefore = await eq.balanceOf(w.treasury.address);
    const minShares = (preview * 99n) / 100n;
    const rc = await guarded(w.treasury, C(A.equity, ABI.equity, w.treasury), 'invest', [SIZES.equityInvest, minShares], {}, 'equity invest(19000)', 500);
    const balAfter = await eq.balanceOf(w.treasury.address);
    const shares = balAfter - balBefore;
    const dev = Number(shares - preview) / Number(preview);
    log(`  tranche2: preview=${fmtE(preview)} shares=${fmtE(shares)} dev=${(dev * 100).toFixed(3)}%`);
    if (Math.abs(dev) > 0.01) throw new Error(`tranche2 shares deviated ${(dev * 100).toFixed(2)}% > 1%`);
    return { tx: rc.hash, invested: fmtE(SIZES.equityInvest), previewShares: fmtE(preview), sharesReceived: fmtE(shares), deviationPct: Number((dev * 100).toFixed(4)), priceAfter: (await eq.price()).toString(), totalSharesAfter: fmtE(await eq.totalSupply()) };
  });

  const summary = {
    treasuryDogeAfter: fmtE(await provider.getBalance(w.treasury.address)),
    treasuryK9usdAfter: fmtE(await C(A.k9usd, ABI.erc20).balanceOf(w.treasury.address)),
    deployerDogeAfter: fmtE(await provider.getBalance(w.deployer.address)),
    results: Object.fromEntries(Object.entries(state.stages).filter(([k]) => k !== 'feePreflight').map(([k, v]) => [k, v.result])),
  };
  state.summary = summary;
  save();
  console.log('\n===== P2 SUMMARY =====');
  console.log(JSON.stringify(summary, null, 2));
  log('P2 complete.');
} catch (e) {
  console.error('\n!!!! P2 ABORTED:', e.message);
  save();
  process.exit(1);
}
