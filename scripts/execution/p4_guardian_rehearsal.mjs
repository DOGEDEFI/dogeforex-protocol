// DogeForex ops — Stage P4: guardian admission-gate rehearsal on ONE instance (EUR).
// Proves the designed pause scope on-chain: pause blocks suggestMinter/openPosition/clone,
// never blocks mint/challenge/transfers; unpause goes through the 72h timelock.
// Runbook: guardian key signs; fee-preflight abort on regime shift; state file resumes.
// Usage: node scripts/execution/p4_guardian_rehearsal.mjs
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ethers } from 'ethers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const REG = JSON.parse(readFileSync(join(ROOT, 'deployments/k9usd.chikyu.json'), 'utf8'));
const KEYS = JSON.parse(readFileSync(process.env.HOME + '/.dogeforex/keys.json', 'utf8'));
const REHEARSAL = JSON.parse(readFileSync(process.env.HOME + '/.dogeforex/rehearsal-positions.json', 'utf8'));
const STATE_FILE = process.env.HOME + '/.dogeforex/guardian-rehearsal.json';
const RPC = process.env.RPC_URL_CHIKYU || REG.network?.rpcUrl || 'https://rpc.testnet.dogeos.com';
const BASELINE_RATE = 0.000071; // DOGE/B, runbook baseline
const CODE = 'EUR';

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { stages: {} };
// OPS-03(a): atomic state write — tmp file + rename, so a kill mid-save can't truncate the JSON
// (a truncated state file killed every subsequent retry at startup on JSON.parse).
const save = () => {
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
};
const done = (k) => state.stages[k]?.done === true;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmtE = (v) => ethers.formatEther(v);

// OPS-03(b): pid lock around the whole run — the cron retries every 15 min and an RPC slower
// than the interval would otherwise double-send pause()/scheduleUnpause(). A live holder means
// another iteration is already running: exit 0 and leave its lock alone.
const LOCK_FILE = STATE_FILE + '.lock';
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
if (existsSync(LOCK_FILE)) {
  const holder = Number(readFileSync(LOCK_FILE, 'utf8').trim());
  if (Number.isInteger(holder) && holder > 0 && pidAlive(holder)) {
    log('lock held by live pid', holder, '— another loop iteration is running; exit 0');
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

const provider = new ethers.JsonRpcProvider(RPC);
const guardian = new ethers.Wallet(KEYS.roles.guardian.privateKey, provider);
const deployer = new ethers.Wallet(KEYS.roles.deployer.privateKey, provider);

const inst = REG.instances[CODE];
const A = {
  timelock: inst.guardianTimelock.address,
  token: inst.token.address,
  hub: inst.mintingHub.address,
  position: REHEARSAL[CODE].position,
};
const ABI = {
  timelock: JSON.parse(readFileSync(join(ROOT, 'abi/GuardianTimelock.json'), 'utf8')),
  token: JSON.parse(readFileSync(join(ROOT, 'abi/OracleFreeDollar.json'), 'utf8')),
  hub: JSON.parse(readFileSync(join(ROOT, 'abi/MintingHub.json'), 'utf8')),
  position: JSON.parse(readFileSync(join(ROOT, 'abi/Position.json'), 'utf8')),
  erc20: JSON.parse(readFileSync(join(ROOT, 'abi/ERC20.json'), 'utf8')),
};
const C = (addr, abi, w) => new ethers.Contract(addr, abi, w ?? provider);
const ADMISSION_PAUSED = ethers.id('AdmissionPaused()').slice(0, 10);
const HOT = '0x700a083c';

async function totalFee(rc) {
  const raw = await provider.send('eth_getTransactionReceipt', [rc.hash]);
  const l2 = BigInt(raw.gasUsed) * BigInt(raw.effectiveGasPrice);
  const l1 = raw.l1Fee ? BigInt(raw.l1Fee) : 0n;
  return l1 + l2;
}

let feeRate = null;
async function feePreflight() {
  if (done('feePreflight')) { feeRate = state.stages.feePreflight.rate; return; }
  log('STAGE feePreflight: 0-value self-transfer probe from guardian');
  const tok = C(A.token, ABI.token, guardian);
  await tok.transfer.staticCall(guardian.address, 0n);
  const tx = await tok.transfer(guardian.address, 0n);
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
  // Runbook fee form: l1Fee ~ rate × (calldataBytes + 170). The old (bytes - 110)
  // model goes NEGATIVE on tiny calldata (e.g. pause() = 4B) and halts wrongly.
  const expected = feeRate * (bytes + 170);
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
  return result;
}

try {
  if (guardian.address.toLowerCase() !== inst.guardianTimelock.guardian.toLowerCase())
    throw new Error('guardian key address does not match registry guardian');
  log('guardian', guardian.address, '| timelock', A.timelock);

  await stage('ensureGas', async () => {
    const bal = await provider.getBalance(guardian.address);
    if (bal >= ethers.parseEther('1.2')) { log('  balance', fmtE(bal), 'ok'); return { balance: fmtE(bal) }; }
    log('  balance', fmtE(bal), '< 1.2 — top up 0.5 from deployer (S-19 floor)');
    const tx = await deployer.sendTransaction({ to: guardian.address, value: ethers.parseEther('0.5') });
    await tx.wait(1);
    const b2 = await provider.getBalance(guardian.address);
    log('  new balance', fmtE(b2));
    return { balance: fmtE(b2), topUpTx: tx.hash };
  });

  await feePreflight();

  const tl = C(A.timelock, ABI.timelock, guardian);
  const tok = C(A.token, ABI.token, guardian);
  const hub = C(A.hub, ABI.hub, guardian);
  const pos = C(A.position, ABI.position, guardian);

  await stage('preState', async () => {
    const r = {
      tokenGuardian: (await C(A.token, ABI.token).guardian()).toLowerCase(),
      timelockGuardian: (await C(A.timelock, ABI.timelock).guardian()).toLowerCase(),
      paused: await C(A.timelock, ABI.timelock).paused(),
      hubGate: await C(A.hub, ABI.hub).admissionGuardianPaused(),
      unpauseAvailableAt: Number(await C(A.timelock, ABI.timelock).unpauseAvailableAt()),
    };
    if (r.paused) throw new Error('timelock already paused — manual recovery required');
    if (r.tokenGuardian !== A.timelock.toLowerCase()) throw new Error('token guardian not wired to timelock');
    log('  gate open, guardian wiring ok');
    return r;
  });

  await stage('pause', async () => {
    const rc = await send(guardian, tl, 'pause', [], 'timelock.pause()');
    if (!(await C(A.timelock, ABI.timelock).paused())) throw new Error('paused() still false after pause()');
    if (!(await C(A.hub, ABI.hub).admissionGuardianPaused())) throw new Error('hub gate still open after pause()');
    return { tx: rc.hash, paused: true };
  });

  await stage('scopeBlocked', async () => {
    const r = {
      suggestMinter: await revertOf(() => tok.suggestMinter.staticCall(guardian.address, 0n, 0n, 'probe')),
      openPosition: await revertOf(() => hub.openPosition.staticCall(A.token, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n)),
      clone4: await revertOf(() => hub['clone(address,uint256,uint256,uint40)'].staticCall(A.position, 0n, 0n, 0n)),
      clone5: await revertOf(() => hub['clone(address,address,uint256,uint256,uint40)'].staticCall(A.position, A.position, 0n, 0n, 0n)),
    };
    for (const [k, v] of Object.entries(r)) {
      if (v !== ADMISSION_PAUSED) throw new Error(`${k} did not revert AdmissionPaused (got ${v})`);
      log(' ', k, 'reverts AdmissionPaused ✓');
    }
    return r;
  });

  await stage('scopeOpen', async () => {
    const r = {};
    r.challenge = await revertOf(() => hub.challenge.staticCall(A.position, 100n * 10n ** 18n, 100n * 10n ** 18n));
    if (r.challenge !== null) throw new Error(`challenge staticCall unexpectedly reverts: ${r.challenge}`);
    log('  challenge (rehearsal position) succeeds while paused ✓');
    r.transfer = await revertOf(() => tok.transfer.staticCall(guardian.address, 0n));
    if (r.transfer !== null) throw new Error(`transfer unexpectedly reverts: ${r.transfer}`);
    log('  token transfer succeeds while paused ✓');
    r.mint = await revertOf(() => pos.mint.staticCall(1n));
    if (r.mint !== HOT) throw new Error(`position.mint expected Hot() while in cooldown, got ${r.mint}`);
    log('  position.mint reverts only Hot() (cooldown), NOT the gate — mint ungated ✓');
    r.note = 'mint blocked by position cooldown until 2026-10-24; gate non-interference proven by selector';
    return r;
  });

  await stage('scheduleUnpause', async () => {
    const rc = await send(guardian, tl, 'scheduleUnpause', [], 'timelock.scheduleUnpause()');
    const avail = Number(await C(A.timelock, ABI.timelock).unpauseAvailableAt());
    const now = Math.floor(Date.now() / 1000);
    const delta = avail - now;
    if (delta < 250000 || delta > 270000) throw new Error(`unpauseAvailableAt delta ${delta}s != ~259200s`);
    log('  unpause executable at', new Date(avail * 1000).toISOString(), `(${Math.round(delta / 3600)}h)`);
    return { tx: rc.hash, unpauseAvailableAt: avail, unpauseAvailableAtIso: new Date(avail * 1000).toISOString() };
  });

  // OPS-03(c): persist the 72h follow-up in the state file (replaces the old bare console.log):
  // an operator reads the exact executable timestamp from stages.scheduleUnpause.result.
  const schedRes = state.stages.scheduleUnpause?.result;
  if (schedRes && schedRes.followUp !== 'timelock.unpause()') {
    state.stages.scheduleUnpause.result = { ...schedRes, followUp: 'timelock.unpause()', notBefore: schedRes.unpauseAvailableAt };
    save();
  }
  const followUp = state.stages.scheduleUnpause?.result;
  if (followUp?.followUp) log('DONE. Follow-up recorded in state:', followUp.followUp, 'from guardian, not before', new Date(followUp.notBefore * 1000).toISOString());
} catch (e) {
  console.error('FATAL', e);
  process.exitCode = 1;
} finally {
  releaseLock();
}
