// DogeForex ops — P6: G1 bridge bootstrap simulation (the Frankencoin start) on all 11 Chikyu instances.
// Simulates ZCHF's XCHF-bridge genesis organically:
//   1. treasury suggests each instance's StablecoinBridge as a minter (1,000 K9XXX fee, 900 s
//      application period — Chikyu testnet parameter, NOT mainnet's 14 d). Instances whose
//      admission gate is guardian-paused are recorded deferred and retried on the next run
//      (p6 is idempotent — re-run after the Oct-24 unpause completes EUR).
//   2. after the window matures: deployer mints testStable to lp + treasury; lp and treasury
//      lock testStable via bridge.mint (1:1 K9XXX); lp redeems a slice via bridge.burn;
//      lp seeds the natural K9XXX/testStableXXX Barkswap pool at par (Algebra pattern from p3).
// Guards: pid lock, atomic state, fee-preflight abort >2x baseline 7.1e-5 DOGE/B, per-tx 3x
// TOTAL-fee (L1+L2) guard. Staged + resumable (state in ~/.dogeforex/bridge-bootstrap.json).
// Safe to re-run: every stage re-checks on-chain state before sending. NEVER prints key material.
// Usage: node scripts/execution/p6_bridge_bootstrap.mjs
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ethers } from 'ethers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const REG = JSON.parse(readFileSync(join(ROOT, 'deployments/k9usd.chikyu.json'), 'utf8'));
const KEYS_FILE = process.env.HOME + '/.dogeforex/keys.json';
const STATE_FILE = process.env.HOME + '/.dogeforex/bridge-bootstrap.json';
const DEPLOY_DIR = join(ROOT, 'scripts/deployment/deployments/chikyu/');
const RPC = process.env.RPC_URL_CHIKYU || REG.network?.rpc?.[0] || 'https://rpc.testnet.dogeos.com';
const CHAIN_ID = REG.network?.chainId ?? 6281971;
const BASELINE_RATE = 0.000071;
const Q96 = 1n << 96n;
const ERC721_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BARKSWAP = {
  factory: ethers.getAddress('0xF3961157f56C983316657f0267B4C04460beE43f'),
  pm: ethers.getAddress('0xf596329a6c7E03F0708199cB5435f86783DB4302'),
};

const CODES = Object.keys(REG.instances);
const SIZES = {
  appPeriod: 900n, // Chikyu MIN_APPLICATION_PERIOD (paramsOracleFreeDollar.json)
  suggestFee: ethers.parseUnits('1000', 18), // MIN_FEE
  lpTestStable: ethers.parseUnits('25000', 18),
  treasuryTestStable: ethers.parseUnits('25000', 18),
  lpBridgeIn: ethers.parseUnits('12000', 18),
  treasuryBridgeIn: ethers.parseUnits('20000', 18),
  lpRedeem: ethers.parseUnits('500', 18),
  poolStable: ethers.parseUnits('10000', 18),
  poolK9: ethers.parseUnits('10000', 18),
  lpDogeFloor: ethers.parseEther('0.5'),
  minTreasuryK9: ethers.parseUnits('1000', 18), // must cover the suggestMinter fee
};

const ABI = {
  erc20: ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'],
  token: ['function suggestMinter(address,uint256,uint256,string)', 'function isMinter(address) view returns (bool)', 'function minters(address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'],
  stable: ['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'],
  bridge: ['function mint(uint256)', 'function burn(uint256)', 'function minted() view returns (uint256)', 'function limit() view returns (uint256)'],
  factory: ['function createPool(address,address,bytes) returns (address)', 'function poolByPair(address,address) view returns (address)'],
  pool: ['function token0() view returns (address)', 'function token1() view returns (address)', 'function initialize(uint160)', 'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFee, bool unlocked)', 'function liquidity() view returns (uint128)', 'function tickSpacing() view returns (int24)'],
  pm: ['function mint((address token0, address token1, address deployer, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'],
};

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { stages: {} };
const save = () => {
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
};
const done = (k) => state.stages[k]?.done === true;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmtE = (v) => ethers.formatEther(v);

const LOCK_FILE = STATE_FILE + '.lock';
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (existsSync(LOCK_FILE)) {
  const holder = Number(readFileSync(LOCK_FILE, 'utf8').trim());
  if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
    log('lock held by live pid', holder, '— another run is in progress; exit 0');
    process.exit(0);
  }
  log('stale lock from dead pid', holder, '— taking over');
}
writeFileSync(LOCK_FILE, String(process.pid));
const releaseLock = () => {
  try {
    if (existsSync(LOCK_FILE) && readFileSync(LOCK_FILE, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK_FILE);
  } catch { /* best effort */ }
};

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

// keys.json is read once; lp creation rewrites it atomically (address logged, key never printed)
let KEYS = JSON.parse(readFileSync(KEYS_FILE, 'utf8'));
const walletOf = (role) => new ethers.Wallet(KEYS.roles[role].privateKey, provider);

const instOf = (code) => {
  const inst = REG.instances[code];
  if (!inst?.token?.address || !inst?.mintingHub?.address) throw new Error('registry missing token/hub for ' + code);
  const read = (suffix) => {
    const f = join(DEPLOY_DIR, `${code}_${suffix}.json`);
    if (!existsSync(f)) throw new Error(`deployment artifact missing: ${f} — run 08_test_stables + 09_bridges first`);
    return ethers.getAddress(JSON.parse(readFileSync(f, 'utf8')).address);
  };
  return {
    token: ethers.getAddress(inst.token.address),
    hub: ethers.getAddress(inst.mintingHub.address),
    stable: read('TestStable'),
    bridge: read('Bridge'),
  };
};

const C = (addr, abi, w) => new ethers.Contract(addr, abi, w ?? provider);

async function totalFee(rc) {
  const raw = await provider.send('eth_getTransactionReceipt', [rc.hash]);
  const l2 = BigInt(raw.gasUsed) * BigInt(raw.effectiveGasPrice);
  const l1 = raw.l1Fee ? BigInt(raw.l1Fee) : 0n;
  return l1 + l2;
}

let feeRate = null;
async function feePreflight(deployer) {
  if (done('feePreflight')) { feeRate = state.stages.feePreflight.rate; return; }
  log('STAGE feePreflight: 0-value self-transfer probe from deployer (TOTAL fee, L1+L2)');
  const tok = C(instOf(CODES[0]).token, ABI.erc20, deployer);
  await tok.transfer.staticCall(deployer.address, 0n);
  const tx = await tok.transfer(deployer.address, 0n);
  const rc = await tx.wait(1);
  const bytes = (tx.data.length - 2) / 2;
  const rate = Number(fmtE(await totalFee(rc))) / bytes;
  const ratio = rate / BASELINE_RATE;
  log(`  probe: ${bytes}B, fee ${fmtE(await totalFee(rc))} DOGE => ${rate.toExponential(2)} DOGE/B (${ratio.toFixed(2)}x baseline)`);
  if (ratio > 2) throw new Error(`FEE REGIME SHIFT: ${ratio.toFixed(2)}x baseline — abort per runbook`);
  state.stages.feePreflight = { done: true, rate, ratio, tx: tx.hash };
  save();
  feeRate = rate;
}

async function send(wallet, contract, method, args, label) {
  await contract[method].staticCall(...args);
  const tx = await contract[method](...args);
  const rc = await tx.wait(1);
  const fee = Number(fmtE(await totalFee(rc)));
  const bytes = tx.data.length / 2 - 1;
  const expected = 0.011 + feeRate * (bytes - 110);
  if (fee > 3 * expected) throw new Error(`${label}: fee ${fee} > 3x expected ${expected.toFixed(4)} — halt`);
  log(`  ${label}: ok tx=${rc.hash.slice(0, 14)}.. totalFee=${fee.toFixed(4)}`);
  return rc;
}

async function revertInfo(fn) {
  try { await fn(); return null; } catch (e) {
    return { msg: String(e.shortMessage || e.message || e).slice(0, 120) };
  }
}

async function ensureAllowance(wallet, tokenAddr, spender, min, amount, label) {
  const t = C(tokenAddr, ABI.erc20, wallet);
  const cur = await t.allowance(wallet.address, spender);
  if (cur >= min) { log(`  ${label}: allowance ${fmtE(cur)} ok`); return { skipped: true, allowance: fmtE(cur) }; }
  const rc = await send(wallet, t, 'approve', [spender, amount], label + ' approve');
  const after = await t.allowance(wallet.address, spender);
  if (after < min) throw new Error(`${label}: allowance ${fmtE(after)} still < required after approve`);
  return { tx: rc.hash, allowance: fmtE(after) };
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // --- lp wallet: create if absent (key written to keys.json, never printed), fund to ~2 tDOGE
  await stage('lpEnsure', async () => {
    if (!KEYS.roles?.lp?.privateKey) {
      const w = ethers.Wallet.createRandom();
      KEYS.roles.lp = { privateKey: w.privateKey, address: w.address };
      const tmp = KEYS_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(KEYS, null, 2));
      renameSync(tmp, KEYS_FILE);
      log('  created lp wallet', w.address, '(key stored in keys.json — not printed)');
    }
    const lp = walletOf('lp');
    const deployer = walletOf('deployer');
    const bal = await provider.getBalance(lp.address);
    if (bal < ethers.parseEther('1')) {
      await feePreflightRefForFunding(deployer);
      const tx = await deployer.sendTransaction({ to: lp.address, value: ethers.parseEther('2') });
      const rc = await tx.wait(1);
      const fee = Number(fmtE(await totalFee(rc)));
      log(`  funded lp with 2 tDOGE (fee ${fee.toFixed(4)})`);
    }
    return { lp: lp.address, doge: fmtE(await provider.getBalance(lp.address)) };
  });

  async function feePreflightRefForFunding(deployer) {
    if (!feeRate) await feePreflight(deployer);
  }

  const deployer = walletOf('deployer');
  const treasury = walletOf('treasury');
  const lp = walletOf('lp');

  if (deployer.address.toLowerCase() !== REG.roles.deployer.toLowerCase()) throw new Error('deployer key != registry roles.deployer');
  if (treasury.address.toLowerCase() !== REG.roles.treasury.toLowerCase()) throw new Error('treasury key != registry roles.treasury');

  log('deployer', deployer.address, '| treasury', treasury.address, '| lp', lp.address);
  log('instances:', CODES.join(', '));

  await stage('preState', async () => {
    const r = { lpDoge: fmtE(await provider.getBalance(lp.address)), treasuryK9: {}, gaps: [] };
    if (ethers.parseEther(r.lpDoge) < SIZES.lpDogeFloor) throw new Error(`lp DOGE ${r.lpDoge} < floor — fund lp first`);
    for (const code of CODES) {
      const { token, stable, bridge } = instOf(code);
      const k9 = await C(token, ABI.token).balanceOf(treasury.address);
      r.treasuryK9[code] = fmtE(k9);
      if (k9 < SIZES.minTreasuryK9) r.gaps.push(`${code} treasury K9 ${fmtE(k9)} < ${fmtE(SIZES.minTreasuryK9)} (suggestMinter fee unpayable)`);
      const bridgeCheck = await revertInfo(() => C(bridge, ABI.bridge).minted());
      if (bridgeCheck) r.gaps.push(`${code} bridge unreadable: ${bridgeCheck.msg}`);
    }
    if (r.gaps.length) throw new Error('preState gaps:\n  ' + r.gaps.join('\n  '));
    return r;
  });

  await feePreflight(deployer);

  // --- 1) organic minter application (deferred, not failed, if the admission gate is paused)
  for (const code of CODES) {
    const { token, bridge } = instOf(code);
    const key = `suggest_${code}`;
    if (done(key)) { log('SKIP (done):', key); continue; }
    log('STAGE:', key);
    const tok = C(token, ABI.token, treasury);
    const probe = await revertInfo(() => tok.suggestMinter.staticCall(bridge, SIZES.appPeriod, SIZES.suggestFee, `G1 test${code} bridge — Frankencoin-start simulation`));
    if (probe) {
      if (probe.msg.includes('AdmissionPaused')) {
        state.stages[key] = { done: false, deferred: 'admission-paused', note: 're-run after guardian unpause' };
        save();
        log(`  ${code}: admission gate paused — DEFERRED (retry after unpause)`);
        continue;
      }
      if (probe.msg.includes('AlreadyRegistered')) {
        state.stages[key] = { done: true, result: { skipped: 'already registered' } };
        save();
        continue;
      }
      throw new Error(`${code} suggestMinter staticCall reverts: ${probe.msg}`);
    }
    const rc = await send(treasury, tok, 'suggestMinter', [bridge, SIZES.appPeriod, SIZES.suggestFee, `G1 test${code} bridge — Frankencoin-start simulation`], `${code} suggestMinter(bridge)`);
    const validity = await C(token, ABI.token).minters(bridge);
    state.stages[key] = { done: true, result: { tx: rc.hash, validityStart: Number(validity) } };
    save();
  }

  // --- 2) wait for the application window (900 s), then assert maturity
  const suggested = CODES.filter((c) => {
    const s = state.stages[`suggest_${c}`];
    return s?.done === true && (s.result?.tx || s.result?.skipped === 'already registered');
  });
  const deferred = CODES.filter((c) => state.stages[`suggest_${c}`]?.deferred);
  const maturityTs = suggested.length
    ? Math.max(...suggested.map((c) => state.stages[`suggest_${c}`].result.validityStart))
    : 0;

  await stage('waitWindow', async () => {
    if (!suggested.length) return { skipped: true, note: 'nothing to wait for' };
    const now = Math.floor(Date.now() / 1000);
    const waitMs = (maturityTs + 45 - now) * 1000;
    if (waitMs > 0) {
      log(`  waiting ${Math.round(waitMs / 1000)}s for application window (maturity ${new Date(maturityTs * 1000).toISOString()})…`);
      await sleep(waitMs);
    }
    const r = {};
    for (const code of suggested) {
      const { token, bridge } = instOf(code);
      const ok = await C(token, ABI.token).isMinter(bridge);
      r[code] = ok;
      if (!ok) throw new Error(`${code} bridge not isMinter after window — investigate`);
    }
    return r;
  });

  const active = suggested.filter((c) => state.stages.waitWindow?.result?.[c] !== false);
  log('active bridges:', active.join(', ') || '(none)', '| deferred:', deferred.join(', ') || '(none)');

  // --- 3) test-stable distribution (deployer-gated mint)
  for (const code of CODES) {
    const { stable } = instOf(code);
    await stage(`stableMint_${code}`, async () => {
      const s = C(stable, ABI.stable, deployer);
      const lpBal = await s.balanceOf(lp.address);
      const trBal = await s.balanceOf(treasury.address);
      const out = {};
      if (lpBal < SIZES.lpTestStable) {
        const rc = await send(deployer, s, 'mint', [lp.address, SIZES.lpTestStable - lpBal], `${code} testStable.mint(lp)`);
        out.lpTx = rc.hash;
      }
      if (trBal < SIZES.treasuryTestStable) {
        const rc = await send(deployer, s, 'mint', [treasury.address, SIZES.treasuryTestStable - trBal], `${code} testStable.mint(treasury)`);
        out.treasuryTx = rc.hash;
      }
      return { lp: fmtE(await s.balanceOf(lp.address)), treasury: fmtE(await s.balanceOf(treasury.address)), ...out };
    });
  }

  // --- 4) the Frankencoin move: lock testStable, mint K9 1:1 (lp + treasury), then lp redeems
  for (const code of active) {
    const { token, stable, bridge } = instOf(code);
    await stage(`bridgeIn_lp_${code}`, async () => {
      await ensureAllowance(lp, stable, bridge, SIZES.lpBridgeIn, ethers.MaxUint256, `${code} lp testStable->bridge`);
      const k9Before = await C(token, ABI.erc20).balanceOf(lp.address);
      await send(lp, C(bridge, ABI.bridge, lp), 'mint', [SIZES.lpBridgeIn], `${code} lp bridge.mint(${fmtE(SIZES.lpBridgeIn)})`);
      const k9After = await C(token, ABI.erc20).balanceOf(lp.address);
      if (k9After - k9Before !== SIZES.lpBridgeIn) throw new Error(`${code} lp K9 delta ${fmtE(k9After - k9Before)} != ${fmtE(SIZES.lpBridgeIn)}`);
      return { k9: fmtE(k9After) };
    });
  }
  for (const code of active) {
    const { token, stable, bridge } = instOf(code);
    await stage(`bridgeIn_treasury_${code}`, async () => {
      await ensureAllowance(treasury, stable, bridge, SIZES.treasuryBridgeIn, ethers.MaxUint256, `${code} treasury testStable->bridge`);
      const k9Before = await C(token, ABI.erc20).balanceOf(treasury.address);
      await send(treasury, C(bridge, ABI.bridge, treasury), 'mint', [SIZES.treasuryBridgeIn], `${code} treasury bridge.mint(${fmtE(SIZES.treasuryBridgeIn)})`);
      const k9After = await C(token, ABI.erc20).balanceOf(treasury.address);
      if (k9After - k9Before !== SIZES.treasuryBridgeIn) throw new Error(`${code} treasury K9 delta mismatch`);
      return { k9: fmtE(k9After), bridgeMinted: fmtE(await C(bridge, ABI.bridge).minted()) };
    });
  }
  for (const code of active) {
    const { token, stable, bridge } = instOf(code);
    await stage(`redeem_lp_${code}`, async () => {
      const k9Before = await C(token, ABI.erc20).balanceOf(lp.address);
      const stBefore = await C(stable, ABI.erc20).balanceOf(lp.address);
      await send(lp, C(bridge, ABI.bridge, lp), 'burn', [SIZES.lpRedeem], `${code} lp bridge.burn(${fmtE(SIZES.lpRedeem)})`);
      const k9After = await C(token, ABI.erc20).balanceOf(lp.address);
      const stAfter = await C(stable, ABI.erc20).balanceOf(lp.address);
      if (k9Before - k9After !== SIZES.lpRedeem || stAfter - stBefore !== SIZES.lpRedeem)
        throw new Error(`${code} redeem deltas wrong: K9 ${fmtE(k9Before - k9After)}, stable ${fmtE(stAfter - stBefore)}`);
      return { k9: fmtE(k9After), stable: fmtE(stAfter) };
    });
  }

  // --- 5) natural pool: lp seeds K9XXX/testStableXXX at par (Algebra pattern from p3)
  for (const code of active) {
    const { token, stable } = instOf(code);
    await stage(`pool_${code}`, async () => {
      const f = C(BARKSWAP.factory, ABI.factory, lp);
      let pool = await f.poolByPair(stable, token);
      let createTx = null;
      if (pool === ethers.ZeroAddress) {
        const rc = await send(lp, f, 'createPool', [stable, token, '0x'], `${code} createPool(testStable/K9)`);
        createTx = rc.hash;
        pool = await f.poolByPair(stable, token);
      }
      const p = C(pool, ABI.pool, lp);
      const t0 = await p.token0();
      const t1 = await p.token1();
      let gs = await p.globalState();
      let initTx = null;
      if (gs.price === 0n) {
        const rc = await send(lp, p, 'initialize', [Q96], `${code} pool initialize(par)`);
        initTx = rc.hash;
        gs = await p.globalState();
      }
      const spacing = Number(await p.tickSpacing());
      const tickLower = Math.floor(-51 / spacing) * spacing;
      const tickUpper = Math.ceil(51 / spacing) * spacing;
      await ensureAllowance(lp, stable, BARKSWAP.pm, SIZES.poolStable, `${code} lp testStable->PM`);
      await ensureAllowance(lp, token, BARKSWAP.pm, SIZES.poolK9, `${code} lp K9->PM`);
      const pm = C(BARKSWAP.pm, ABI.pm, lp);
      const stableIs0 = t0.toLowerCase() === stable.toLowerCase();
      const amt0 = stableIs0 ? SIZES.poolStable : SIZES.poolK9;
      const amt1 = stableIs0 ? SIZES.poolK9 : SIZES.poolStable;
      const params = { token0: t0, token1: t1, deployer: ethers.ZeroAddress, tickLower, tickUpper, amount0Desired: amt0, amount1Desired: amt1, amount0Min: 0n, amount1Min: 0n, recipient: lp.address, deadline: Math.floor(Date.now() / 1000) + 1800 };
      let tokenId, liquidity, mintTx;
      if ((await p.liquidity()) > 0n) {
        const logs = await provider.getLogs({ address: BARKSWAP.pm, fromBlock: (await provider.getBlockNumber()) - 50000, toBlock: 'latest', topics: [ERC721_TRANSFER, null, '0x000000000000000000000000' + lp.address.slice(2).toLowerCase()] });
        const last = logs[logs.length - 1];
        tokenId = BigInt(last.topics[3]).toString();
        liquidity = (await p.liquidity()).toString();
        mintTx = last.transactionHash;
        log(`  ${code} mint already done (tokenId ${tokenId})`);
      } else {
        const sim = await pm.mint.staticCall(params);
        const rc = await send(lp, pm, 'mint', [params], `${code} PM mint`);
        tokenId = sim[0].toString();
        liquidity = sim[1].toString();
        mintTx = rc.hash;
      }
      const gs2 = await p.globalState();
      const rawRatio = (BigInt(gs2.price) * BigInt(gs2.price)) >> 192n;
      const stablePerK9 = stableIs0 ? (10n ** 36n / rawRatio) / 10n ** 18n : rawRatio * 10n ** 18n;
      const par = Number(fmtE(stablePerK9));
      log(`  ${code} pool=${pool} implied testStable/K9=${par} ticks [${tickLower},${tickUpper}]`);
      if (Math.abs(par - 1.0) > 0.01) throw new Error(`${code} par ${par} outside 1% — abort`);
      return { pair: `test${code}/${code}`, pool, lpTokenId: tokenId, liquidity, ticks: [tickLower, tickUpper], impliedTestStablePerK9: par, createTx, initializeTx: initTx, mintTx, lpOwner: lp.address };
    });
  }

  state.summary = {
    ranAt: new Date().toISOString(),
    active,
    deferred,
    lp: lp.address,
    deployerDogeAfter: fmtE(await provider.getBalance(deployer.address)),
    treasuryDogeAfter: fmtE(await provider.getBalance(treasury.address)),
    lpDogeAfter: fmtE(await provider.getBalance(lp.address)),
    results: Object.fromEntries(Object.entries(state.stages).filter(([k]) => !['feePreflight'].includes(k)).map(([k, v]) => [k, v.result ?? v])),
  };
  save();
  console.log('\n===== P6 BRIDGE BOOTSTRAP SUMMARY =====');
  console.log(JSON.stringify(state.summary, null, 2));
  log('P6 complete.' + (deferred.length ? ` Deferred (re-run after gate opens): ${deferred.join(', ')}` : ''));
} catch (e) {
  console.error('FATAL', e);
  process.exitCode = 1;
} finally {
  releaseLock();
}
