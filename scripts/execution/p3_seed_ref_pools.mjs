// DogeForex P3 — seed MOFX/K9XXX par reference pools for all non-USD instances (Chikyu, chain 6281971)
// Staged + resumable (state in ~/.dogeforex/p3-pools-state.json). Every mutating call is
// staticCall-validated first; fee-guarded per the runbook 2x-baseline preflight.
// The par pool is the oracle-free price anchor for challenge pricing (runbook §3.2).
// Keys are loaded programmatically and never printed.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ethers } from 'ethers';

const RPC = 'https://rpc.testnet.dogeos.com';
const CHAIN_ID = 6281971;
const STATE_FILE = '/Users/tonicaradonna/.dogeforex/p3-pools-state.json';
const DEPLOY_DIR = new URL('../deployment/deployments/chikyu/', import.meta.url).pathname;

const A = {
  mofx: '0x2F0393CEb21b040722D36b628DB2C75aB0E0b156',
  factory: '0xF3961157f56C983316657f0267B4C04460beE43f',
  pm: '0xf596329a6c7E03F0708199cB5435f86783DB4302',
};
for (const [k, v] of Object.entries(A)) A[k] = ethers.getAddress(v);

const INSTANCES = ['EUR', 'JPY', 'GBP', 'AUD', 'CNY', 'BRL', 'PKR', 'BDT', 'INR', 'NGN'];
const tokenOf = (code) => ethers.getAddress(JSON.parse(readFileSync(`${DEPLOY_DIR}${code}_Token.json`, 'utf8')).address);

const keys = JSON.parse(readFileSync('/Users/tonicaradonna/.dogeforex/keys.json', 'utf8'));
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const w = {
  deployer: new ethers.Wallet(keys.roles.deployer.privateKey, provider),
  treasury: new ethers.Wallet(keys.roles.treasury.privateKey, provider),
};

const ABI = {
  erc20: ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'],
  mofx: ['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'],
  factory: ['function createPool(address,address,bytes) returns (address)', 'function poolByPair(address,address) view returns (address)'],
  pool: ['function token0() view returns (address)', 'function token1() view returns (address)', 'function initialize(uint160)', 'function globalState() view returns (uint160 price, int24 tick, uint16 fee, uint16 timepointIndex, uint8 communityFee, bool unlocked)', 'function liquidity() view returns (uint128)', 'function tickSpacing() view returns (int24)'],
  pm: ['function mint((address token0, address token1, address deployer, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'],
};
const C = (addr, abi, signer) => new ethers.Contract(addr, abi, signer ?? provider);

const SIZES = { refMofx: ethers.parseUnits('500', 18), refK9: ethers.parseUnits('500', 18) };
const Q96 = 1n << 96n;
const ERC721_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : { stages: {}, results: {} };
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const done = (k) => state.stages[k]?.done === true;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmtE = (v) => ethers.formatEther(v);

// Total fee incl. L1 data fee: ethers' parsed receipt drops the chain-specific
// l1Fee field, so re-fetch the raw receipt (registry preflight-bug fix: v1 read
// receipt.fee = L2 execution fee only and passed at 0.00x baseline — WRONG).
async function totalFee(rc) {
  const raw = await provider.send('eth_getTransactionReceipt', [rc.hash]);
  const l2 = BigInt(raw.gasUsed) * BigInt(raw.effectiveGasPrice);
  const l1 = raw.l1Fee ? BigInt(raw.l1Fee) : 0n;
  return l1 + l2;
}

let feeRate = null;
async function feePreflight() {
  if (done('feePreflight')) { feeRate = state.stages.feePreflight.rate; return; }
  log('STAGE feePreflight: probe TOTAL per-byte fee (L2 + l1Fee) with a 0-value self transfer');
  const tok = C(tokenOf(INSTANCES[0]), ABI.erc20, w.deployer);
  await tok.transfer.staticCall(w.deployer.address, 0n);
  const tx = await tok.transfer(w.deployer.address, 0n);
  const rc = await tx.wait(1);
  const bytes = (tx.data.length - 2) / 2;
  const rate = Number(fmtE(await totalFee(rc))) / bytes;
  const ratio = rate / 0.000071;
  log(`  probe: ${bytes}B, total fee ${fmtE(await totalFee(rc))} DOGE => ${rate.toExponential(2)} DOGE/B (${ratio.toFixed(2)}x baseline)`);
  if (ratio > 2) throw new Error(`FEE REGIME SHIFT: ${ratio.toFixed(2)}x baseline > 2x — abort per runbook §1.1`);
  state.stages.feePreflight = { done: true, rate, tx: tx.hash };
  save();
  feeRate = rate;
}

async function guarded(wallet, contract, method, args, opts, label, expectFeeBytes) {
  await contract[method].staticCall(...args, opts);
  const tx = await contract[method](...args, opts);
  const rc = await tx.wait(1);
  const bytes = tx.data.length / 2 - 1;
  const expected = 0.011 + feeRate * ((expectFeeBytes ?? bytes) - 110);
  const fee = Number(fmtE(await totalFee(rc)));
  if (fee > 3 * expected) throw new Error(`${label}: total fee ${fee} > 3x expected ${expected.toFixed(4)} — halt`);
  log(`  ${label}: ok tx=${rc.hash.slice(0, 14)}.. totalFee=${fee.toFixed(4)}`);
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
  return result;
}

try {
  log('deployer', w.deployer.address, '| treasury (LP recipient)', w.treasury.address);
  await feePreflight();

  await stage('mofxMint', async () => {
    const m = C(A.mofx, ABI.mofx, w.deployer);
    const amount = SIZES.refMofx * BigInt(INSTANCES.length);
    const rc = await guarded(w.deployer, m, 'mint', [w.deployer.address, amount], {}, `MOFX.mint(deployer, ${fmtE(amount)})`);
    return { tx: rc.hash, deployerMofx: fmtE(await m.balanceOf(w.deployer.address)) };
  });

  const pools = {};
  for (const code of INSTANCES) {
    pools[code] = await stage('refPool_' + code, async () => {
      const k9 = tokenOf(code);
      const f = C(A.factory, ABI.factory, w.deployer);
      let pool = await f.poolByPair(A.mofx, k9);
      let createTx = null;
      if (pool === ethers.ZeroAddress) {
        const rc = await guarded(w.deployer, f, 'createPool', [A.mofx, k9, '0x'], {}, code + ' createPool');
        createTx = rc.hash;
        pool = await f.poolByPair(A.mofx, k9);
      }
      const p = C(pool, ABI.pool, w.deployer);
      const t0 = await p.token0(); const t1 = await p.token1();
      let gs = await p.globalState();
      let initTx = null;
      if (gs.price === 0n) {
        const rc = await guarded(w.deployer, p, 'initialize', [Q96], {}, code + ' initialize(par)');
        initTx = rc.hash;
        gs = await p.globalState();
      }
      const spacing = Number(await p.tickSpacing());
      const tickLower = Math.floor(-51 / spacing) * spacing;
      const tickUpper = Math.ceil(51 / spacing) * spacing;
      await ensureAllowance(w.deployer, A.mofx, A.pm, SIZES.refMofx, code + ' MOFX->PM');
      await ensureAllowance(w.deployer, k9, A.pm, SIZES.refK9, code + ' K9->PM');
      const pm = C(A.pm, ABI.pm, w.deployer);
      const mofxIs0 = t0.toLowerCase() === A.mofx.toLowerCase();
      const amt0 = mofxIs0 ? SIZES.refMofx : SIZES.refK9;
      const amt1 = mofxIs0 ? SIZES.refK9 : SIZES.refMofx;
      const params = { token0: t0, token1: t1, deployer: ethers.ZeroAddress, tickLower, tickUpper, amount0Desired: amt0, amount1Desired: amt1, amount0Min: 0n, amount1Min: 0n, recipient: w.treasury.address, deadline: Math.floor(Date.now() / 1000) + 1800 };
      let tokenId, liquidity, mintTx;
      if ((await p.liquidity()) > 0n) {
        const logs = await provider.getLogs({ address: A.pm, fromBlock: (await provider.getBlockNumber()) - 50000, toBlock: 'latest', topics: [ERC721_TRANSFER, null, '0x000000000000000000000000' + w.treasury.address.slice(2).toLowerCase()] });
        const last = logs[logs.length - 1];
        tokenId = BigInt(last.topics[3]).toString();
        liquidity = (await p.liquidity()).toString();
        mintTx = last.transactionHash;
        log('  ' + code + ' mint already done (tokenId ' + tokenId + ')');
      } else {
        const sim = await pm.mint.staticCall(params);
        const rc = await guarded(w.deployer, pm, 'mint', [params], {}, code + ' mint', 1500);
        tokenId = sim[0].toString(); liquidity = sim[1].toString(); mintTx = rc.hash;
      }
      const gs2 = await p.globalState();
      const rawRatio = (BigInt(gs2.price) * BigInt(gs2.price)) >> 192n;
      const mofxPerK9 = mofxIs0 ? (10n ** 36n / rawRatio) / 10n ** 18n : rawRatio * 10n ** 18n;
      const par = Number(fmtE(mofxPerK9));
      log(`  ${code} pool=${pool} implied MOFX/K9=${par} ticks [${tickLower},${tickUpper}]`);
      if (Math.abs(par - 1.0) > 0.01) throw new Error(code + ` par ${par} outside 1% — abort`);
      return { pair: `MOFX/${code}`, pool, token0: t0, token1: t1, lpTokenId: tokenId, liquidity, sizes: { mofx: fmtE(SIZES.refMofx), k9: fmtE(SIZES.refK9) }, ticks: [tickLower, tickUpper], tickSpacing: spacing, impliedMofxPerK9: par, createTx, initializeTx: initTx, mintTx, lpOwner: w.treasury.address };
    });
  }

  state.summary = {
    deployerDogeAfter: fmtE(await provider.getBalance(w.deployer.address)),
    deployerMofxAfter: fmtE(await C(A.mofx, ABI.mofx).balanceOf(w.deployer.address)),
    results: Object.fromEntries(Object.entries(state.stages).filter(([k]) => k !== 'feePreflight').map(([k, v]) => [k, v.result])),
  };
  save();
  console.log('\n===== P3 POOLS SUMMARY =====');
  console.log(JSON.stringify(state.summary, null, 2));
  log('P3 pool seeding complete.');
} catch (e) {
  console.error('\n!!!! P3 POOLS ABORTED:', e.message);
  save();
  process.exit(1);
}
