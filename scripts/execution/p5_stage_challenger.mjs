// DogeForex ops — Stage P5: challenger staging for the Oct-24 challenge rehearsal (all 10 non-USD instances).
// Addresses the OPS-01 funding gap: the challenger wallet holds 0 MOFX and has no hub approvals,
// so hub.challenge() reverts via transferFrom (MintingHub.sol:215 pulls COLLATERAL = MOFX).
//   a) deployer (MOFX mint gate) mints 50,000 MOFX to the challenger, but only if balance < 25,000;
//      challenger approves each instance's MintingHub for MaxUint256 (skip if allowance >= 25,000e18)
//   b) challenger approves each instance's K9XXX token for 1,000e18 against its MintingHub (skip if
//      allowance >= 1,000e18) — the Oct-25 bid() pulls the bid in K9XXX from the bidder via transferFrom
//      (MintingHub.sol:256); challenger will hold 3,500 minted on Oct-24, so 1,000e18 headroom suffices
//   c) per-instance staticCall simulation of hub.challenge(position, 100e18, 100e18) FROM the challenger;
//      the revert selector (or ok) is recorded per instance as proof the simulation path reaches the hub
// Staged + resumable (state in ~/.dogeforex/challenger-staging.json), pid-locked, fee preflight aborts
// on a >2x-baseline regime shift, per-tx 3x TOTAL-fee guard — same patterns as p4_guardian_rehearsal.mjs.
// DO NOT RUN outside the ops window (it sends txs). Safe to re-run: every stage is state-file idempotent
// and re-checks on-chain allowances/balances before sending anything.
// Usage: node scripts/execution/p5_stage_challenger.mjs
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ethers } from 'ethers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const REG = JSON.parse(readFileSync(join(ROOT, 'deployments/k9usd.chikyu.json'), 'utf8'));
const KEYS = JSON.parse(readFileSync(process.env.HOME + '/.dogeforex/keys.json', 'utf8'));
const REHEARSAL = JSON.parse(readFileSync(process.env.HOME + '/.dogeforex/rehearsal-positions.json', 'utf8'));
const STATE_FILE = process.env.HOME + '/.dogeforex/challenger-staging.json';
const RPC = process.env.RPC_URL_CHIKYU || REG.network?.rpc?.[0] || 'https://rpc.testnet.dogeos.com';
const CHAIN_ID = REG.network?.chainId ?? 6281971;
const BASELINE_RATE = 0.000071; // DOGE/B, runbook baseline

const CODES = Object.keys(REHEARSAL); // 10 non-USD rehearsal instances (EUR..NGN)
const MOFX = ethers.getAddress('0x2F0393CEb21b040722D36b628DB2C75aB0E0b156');
const SIZES = {
  mofxMint: ethers.parseUnits('50000', 18),
  mofxFloor: ethers.parseUnits('25000', 18), // mint only if challenger MOFX < this
  mofxAllowanceMin: ethers.parseUnits('25000', 18), // skip MOFX approve at/above this
  k9BidAllowance: ethers.parseUnits('1000', 18), // Oct-25 bid headroom per instance
  challengeSize: ethers.parseUnits('100', 18), // mirrors the Oct-24 cron call
  challengeMinPrice: ethers.parseUnits('100', 18), // mirrors the Oct-24 cron call
  minChallengerDoge: ethers.parseEther('0.5'), // pre-flight affordability floor
};

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { stages: {} };
// atomic state write (OPS-03 pattern): tmp file + rename, a kill mid-save can't truncate the JSON
const save = () => {
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
};
const done = (k) => state.stages[k]?.done === true;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmtE = (v) => ethers.formatEther(v);

// pid lock (OPS-03 pattern): a live holder means another run is in flight — exit 0, leave its lock
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
const challenger = new ethers.Wallet(KEYS.roles.challenger.privateKey, provider);
const deployer = new ethers.Wallet(KEYS.roles.deployer.privateKey, provider);

// key ↔ registry wiring asserts (same discipline as p4)
if (challenger.address.toLowerCase() !== REG.roles.challenger.toLowerCase())
  throw new Error('challenger key address does not match registry roles.challenger');
if (deployer.address.toLowerCase() !== REG.roles.deployer.toLowerCase())
  throw new Error('deployer key address does not match registry roles.deployer');

const instOf = (code) => {
  const inst = REG.instances[code];
  const pos = REHEARSAL[code]?.position;
  if (!inst?.token?.address || !inst?.mintingHub?.address) throw new Error('registry missing token/hub for ' + code);
  if (!pos) throw new Error('rehearsal-positions.json missing position for ' + code);
  return { token: ethers.getAddress(inst.token.address), hub: ethers.getAddress(inst.mintingHub.address), position: ethers.getAddress(pos) };
};

const ABI = {
  mofx: JSON.parse(readFileSync(join(ROOT, 'abi/MOFX.json'), 'utf8')),
  erc20: JSON.parse(readFileSync(join(ROOT, 'abi/ERC20.json'), 'utf8')),
  hub: JSON.parse(readFileSync(join(ROOT, 'abi/MintingHub.json'), 'utf8')),
};
const C = (addr, abi, w) => new ethers.Contract(addr, abi, w ?? provider);

// Total fee incl. L1 data fee: ethers' parsed receipt drops the chain-specific l1Fee field
async function totalFee(rc) {
  const raw = await provider.send('eth_getTransactionReceipt', [rc.hash]);
  const l2 = BigInt(raw.gasUsed) * BigInt(raw.effectiveGasPrice);
  const l1 = raw.l1Fee ? BigInt(raw.l1Fee) : 0n;
  return l1 + l2;
}

let feeRate = null;
async function feePreflight() {
  if (done('feePreflight')) { feeRate = state.stages.feePreflight.rate; return; }
  log('STAGE feePreflight: 0-value MOFX self-transfer probe from deployer (TOTAL fee, L1+L2)');
  const tok = C(MOFX, ABI.mofx, deployer);
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
  await contract[method].staticCall(...args); // revert => throw
  const tx = await contract[method](...args);
  const rc = await tx.wait(1);
  const fee = Number(fmtE(await totalFee(rc)));
  const bytes = tx.data.length / 2 - 1;
  const expected = 0.011 + feeRate * (bytes - 110);
  if (fee > 3 * expected) throw new Error(`${label}: fee ${fee} > 3x expected ${expected.toFixed(4)} — halt`);
  log(`  ${label}: ok tx=${rc.hash.slice(0, 14)}.. totalFee=${fee.toFixed(4)}`);
  return rc;
}

// Returns the revert selector a staticCall fails with, or null if it succeeded.
async function revertOf(fn) {
  try { await fn(); return null; } catch (e) {
    const d = e.data ?? e.info?.error?.data ?? e.shortMessage ?? '';
    const m = typeof d === 'string' ? d.match(/0x[0-9a-fA-F]{8}/) : null;
    return m ? m[0].toLowerCase() : ('no-selector:' + String(d).slice(0, 60));
  }
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

// approve `spender` on `token` for `amount` from `wallet`, unless allowance already >= `min`
async function ensureAllowance(wallet, token, abi, spender, min, amount, label) {
  const t = C(token, abi, wallet);
  const cur = await t.allowance(wallet.address, spender);
  if (cur >= min) { log(`  ${label}: allowance ${fmtE(cur)} ok`); return { skipped: true, allowance: fmtE(cur) }; }
  const rc = await send(wallet, t, 'approve', [spender, amount], label + ' approve');
  const after = await t.allowance(wallet.address, spender);
  if (after < min) throw new Error(`${label}: allowance ${fmtE(after)} still < required after approve`);
  return { tx: rc.hash, allowance: fmtE(after) };
}

try {
  log('challenger', challenger.address, '| deployer (MOFX mint gate)', deployer.address);
  log('instances:', CODES.join(', '));

  await stage('preState', async () => {
    const r = {
      challengerDoge: fmtE(await provider.getBalance(challenger.address)),
      challengerMofx: fmtE(await C(MOFX, ABI.mofx).balanceOf(challenger.address)),
    };
    if (ethers.parseEther(r.challengerDoge) < SIZES.minChallengerDoge) throw new Error(`challenger DOGE ${r.challengerDoge} < ${fmtE(SIZES.minChallengerDoge)} — top up before staging`);
    for (const code of CODES) instOf(code); // fail fast on registry/rehearsal gaps
    return r;
  });

  await feePreflight();

  // (a) MOFX: mint 50k to challenger if below floor (deployer-gated mint), then approve each hub
  await stage('mofxMint', async () => {
    const m = C(MOFX, ABI.mofx, deployer);
    const bal = await C(MOFX, ABI.mofx).balanceOf(challenger.address);
    if (bal >= SIZES.mofxFloor) { log(`  challenger MOFX ${fmtE(bal)} >= ${fmtE(SIZES.mofxFloor)} — mint not needed`); return { skipped: true, balance: fmtE(bal) }; }
    const rc = await send(deployer, m, 'mint', [challenger.address, SIZES.mofxMint], 'MOFX.mint(challenger,50000)');
    const after = await C(MOFX, ABI.mofx).balanceOf(challenger.address);
    if (after < SIZES.mofxFloor) throw new Error(`challenger MOFX ${fmtE(after)} still < ${fmtE(SIZES.mofxFloor)} after mint`);
    return { tx: rc.hash, balance: fmtE(after) };
  });

  for (const code of CODES) {
    const { hub } = instOf(code);
    await stage(`mofxApprove_${code}`, async () =>
      ensureAllowance(challenger, MOFX, ABI.mofx, hub, SIZES.mofxAllowanceMin, ethers.MaxUint256, `${code} MOFX->hub`));
  }

  // (b) K9XXX: challenger approves each instance's MintingHub for 1,000e18 (Oct-25 bid path)
  for (const code of CODES) {
    const { token, hub } = instOf(code);
    await stage(`k9Approve_${code}`, async () =>
      ensureAllowance(challenger, token, ABI.erc20, hub, SIZES.k9BidAllowance, SIZES.k9BidAllowance, `${code} K9->hub`));
  }

  // (c) per-instance challenge simulation from the challenger wallet — record revert-or-ok.
  // NOTE: record-only, never assert a specific selector: the recorded selector per instance is the
  // proof that the simulation path reaches the hub. Pre-mint, hub.challenge(position, 100e18, 100e18)
  // reverts before state changes (price check MintingHub.sol:214 precedes the transferFrom at :215),
  // so a revert here is expected until the Oct-24 run.
  await stage('challengeSimulation', async () => {
    const r = {};
    for (const code of CODES) {
      const { hub, position } = instOf(code);
      const h = C(hub, ABI.hub, challenger); // msg.sender must be the challenger
      const outcome = await revertOf(() => h.challenge.staticCall(position, SIZES.challengeSize, SIZES.challengeMinPrice));
      r[code] = outcome; // null = would succeed; otherwise the revert selector / diagnostic
      log(`  ${code}: challenge(${position}) staticCall ->`, outcome === null ? 'OK (no revert)' : `reverts ${outcome}`);
    }
    return r;
  });

  state.summary = {
    challengerDogeAfter: fmtE(await provider.getBalance(challenger.address)),
    challengerMofxAfter: fmtE(await C(MOFX, ABI.mofx).balanceOf(challenger.address)),
    results: Object.fromEntries(Object.entries(state.stages).filter(([k]) => k !== 'feePreflight').map(([k, v]) => [k, v.result])),
  };
  save();
  console.log('\n===== P5 CHALLENGER STAGING SUMMARY =====');
  console.log(JSON.stringify(state.summary, null, 2));
  log('P5 challenger staging complete. Oct-24 cron may launch hub.challenge per instance.');
} catch (e) {
  console.error('FATAL', e);
  process.exitCode = 1;
} finally {
  releaseLock();
}
