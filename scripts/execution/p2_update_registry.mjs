// One-shot registry updater for P2 results. Reads on-chain-verified values captured in p2-state.json
// (checked against the run output) and merges them into deployments/k9usd.chikyu.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const REG = root + '/deployments/k9usd.chikyu.json';
const reg = JSON.parse(readFileSync(REG, 'utf8'));
// OPS-04 loud guard: this script still writes the stale v1 layout (reg.instance singular) and
// clobbers reg.dex. The committed registry is schema v2 (reg.instances, per-currency) — the exact
// file a re-run would corrupt — so refuse to run against any registry carrying the v2 marker.
if (reg.schema === 'dogeforex.registry/v2' || (typeof reg.instances === 'object' && reg.instances !== null))
  throw new Error('registry schema v2 required; this script is stale, do not run');
const st = JSON.parse(readFileSync('/Users/tonicaradonna/.dogeforex/p2-state.json', 'utf8'));
const R = st.summary.results;

const CR = { 'P1-conservative': 171.43, 'P2-degen': 116.13, 'P3-arena-bait': 103.8, 'wDOGE-conservative': 150.04, 'WUFF-150': 150.02 };

reg.updatedAt = new Date().toISOString();
reg.updatedBy = 'P2 execution (scripts/execution/p2_seed_positions.mjs)';

reg.shared.MOFX.treasuryMintP2 = { tx: R.mofxMint.tx, amount: '13700000000000000000000', note: '13,200 position collateral (P1 6,000 / P2 3,600 / P3 3,600) + 500 ref-pool leg' };

reg.dex = {
  engine: 'Barkswap (Algebra, ve(3,3))',
  factory: '0xF3961157f56C983316657f0267B4C04460beE43f',
  positionManager: '0xf596329a6c7E03F0708199cB5435f86783DB4302',
  router: '0x911E5A1630fD1768E5A1710DAAFaBb865cB79531',
  routerVerification: 'on-chain: router.factory() == PM.factory() == factory; router.WNativeToken() == 0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE; barkswap.fi = DogeOS Algebra DEX',
  wdogeForPoolLegs: '0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE',
  wdogeForCollateral: '0x5300000000000000000000000000000000000004',
  wdogeNote: 'runbook assumption 3 locked: pool legs use the wDOGE with Barkswap liquidity (custom, = router WNativeToken); collateral wraps use the canonical predeploy',
};

reg.instance.liquidity = {
  starPool: {
    pair: 'K9USD/wDOGE', pool: R.starPool.pool, token0: R.starPool.token0, token1: R.starPool.token1,
    lpTokenId: R.starPool.tokenId, liquidity: R.starPool.liquidity,
    sizes: { k9usd: R.starPool.sizes.k9usd, wdoge: R.starPool.sizes.wdoge },
    band: 'full-range (ticks -887220..887220)',
    globalStatePrice: R.starPool.globalStatePrice, impliedK9usdPerWdoge: R.starPool.impliedK9usdPerWdoge,
    targetRate: 0.085, check: 'globalState quote within 20% of §0.4 rate — PASS (0.085, lesson §3.4: never derive price from reserves)',
    createTx: '0xff08cb9c297f7bd97bcf64577c0588ae951890babe0a233c8be4be5b1a7b530a',
    initializeTx: '0xebec4fa638704284897d11f54267f467770e74b4263b3653885a6539a5110a69',
    mintTx: R.starPool.tx, lpOwner: '0x1C96FeA6e75b3D9099c0e103644A76DdDb7153d0',
  },
  mofxReferencePool: {
    pair: 'MOFX/K9USD', pool: R.refPool.pool, token0: R.refPool.token0, token1: R.refPool.token1,
    lpTokenId: R.refPool.tokenId, liquidity: R.refPool.liquidity,
    sizes: { mofx: R.refPool.sizes.mofx, k9usd: R.refPool.sizes.k9usd },
    band: '±1% around par', ticks: R.refPool.ticks, tickSpacing: R.refPool.tickSpacing,
    globalStatePrice: R.refPool.globalStatePrice, impliedMofxPerK9usd: R.refPool.impliedMofxPerK9usd,
    check: 'par 1.000 within ±1% — PASS (oracle-free reference for keeper challenges, §3.2)',
    createTx: '0x045155e53f98347548753e2f98ad4a1d0c4ac1bd4a3c3987327e1ff91f9baccf',
    initializeTx: '0x635a1902f66afad90380ecdd544d0ce4de30ff857dd3af888b7d9c12a2b66073',
    mintTx: R.refPool.tx, lpOwner: '0x1C96FeA6e75b3D9099c0e103644A76DdDb7153d0',
  },
};

reg.instance.position = {
  status: 'opened-5-minting-deferred',
  owner: '0x1C96FeA6e75b3D9099c0e103644A76DdDb7153d0',
  verified: false,
  note: 'minting locked during initPeriod deny window (Position.sol cooldown=start; mint reverts Hot() 0x700a083c). P2b mints at mintableAt. Verification of a Position instance deferred to P2b.',
  mintingDeferred: true,
  positions: R.positions.positions.map((p) => ({
    name: p.name, address: p.position, collateral: p.collateral, initialCollateral: p.initialCollateral,
    liqPrice: p.liqPrice, prospectiveMint: p.prospectiveMint, minted: p.minted, mintTx: p.mintTx,
    crPercent: CR[p.name], mintableAt: p.mintableAt, openTx: p.openTx,
    initPeriodDays: 5, challengePeriodDays: 1,
  })),
  minterReserve: { before: R.positions.minterReserveBefore, after: R.positions.minterReserveAfter, note: 'reserve accrues on mint (mintWithReserve) — expected 0 while all mints deferred' },
};

reg.instance.genesis.founderEquityTranche2 = {
  investTx: R.equityTranche2.tx,
  invested: '19000000000000000000000',
  previewShares: R.equityTranche2.previewShares,
  sharesReceived: R.equityTranche2.sharesReceived,
  deviationPct: R.equityTranche2.deviationPct,
  priceAfter: R.equityTranche2.priceAfter,
  totalSharesAfter: R.equityTranche2.totalSharesAfter,
  note: '±1% assert vs calculateShares preview — PASS (0.000%); preview read at equity=6,000 (1,000 tranche1 + 5×1,000 opening fees)',
};

reg.instance.p2Ops = {
  funding: {
    deployerToTreasuryDoge: { tx: R.fundTreasury.tx, amountDoge: '2.5' },
    deployerToTreasuryFloorRestore: { tx: '0xd75ecb2aa95371dd804f82899599e3c0b73d5660d2c4698d4be3f16fb4435d0f', amountDoge: '1.0', note: 'post-run top-up after fee burn pushed treasury to 1.345 (< 2.0 floor)' },
    mofxMintTx: R.mofxMint.tx,
    wuffSourcingTx: R.wuffTransfer.tx,
    wuffSource: 'noise-fleet deployer (sixr-doge-noise wallet pool #0 0xB3b792aF28412722348D95EC19266805dd5B71f6) → treasury 50,000 WUFF',
    wrapCustomTx: R.wrapCustom.tx, wrapCanonTx: R.wrapCanon.tx,
  },
  botBalancesCheck: R.S19_botBalances,
  botBalancesNote: 'S-19 (light): all bot wallets ≥1 tDOGE — recorded, no action',
  feeRegime: {
    finding: 'L1 data fee dominates and has a large per-tx fixed component: observed 0.04–0.09 DOGE/tx total (small txs ≈8e-4 DOGE/B, ~12× the 14 Oct 7.1e-5/B baseline; large txs ≈7e-5/B)',
    preflightBug: 'P2 preflight v1 read receipt.fee only (L2 execution fee, excludes L1 data fee) and passed at 0.00x baseline — WRONG. v2 must quote total fee (Blockscout fee.value or L1 oracle) vs the 2× abort rule',
    totalGasSpentDoge: '1.28',
    action: 'preflight-fee methodology fix required before P3; consider batching txs',
  },
  treasuryAfter: { doge: '2.344970364225134533', k9usd: '424499.575', mofx: '13200', wuff: '49900', customWdoge: '0', canonicalWdoge: '0' },
};

reg.accounting.p2 = {
  date: '2026-10-14',
  gasSpentDoge: '1.28',
  wdogeWrappedDoge: '9.0',
  treasuryBalanceAfterDoge: '2.34497',
  deployerBalanceAfterDoge: '1.82762',
};

reg.deviations = [
  'star pool sized 5 wDOGE / 0.425 K9USD (task: scale down ~4–6 wDOGE from runbook 30/353). Runbook §3.3 K9USD side (353) encodes wDOGE/0.085 ⇒ $11.76 per wDOGE (138× §0.4 rate); seeded at market 0.085 K9USD per wDOGE per §3.4 check, PASS',
  'pool legs on custom wDOGE 0xF6BD…78aE (Barkswap WNativeToken) per runbook assumption 3; canonical predeploy only for position collateral',
  'P3 minCollateral 3,600 (runbook 3,500 reverts: hub floor minCollateral×liqPrice ≥ 3500e36 fails at liq 0.98e18)',
  'P1 minCollateral 4,000 (runbook 5,000 reverts Position.sol:330 price bound liqPrice×minCollateral ≤ mintingMaximum); P2 mintingMaximum 3,500 (runbook 3,200 below hub floor)',
  'all position mints deferred to mintableAt≈2026-10-19T13:1xZ: minting reverts Hot() during the 5-day initPeriod deny window (runbook "mint at T0" is contract-incompatible); minterReserve verification likewise deferred to P2b',
  'wDOGE position liqPrice 1,000 K9USD/wDOGE (≈11,765× spot): market-priced wDOGE collateral infeasible on treasury float (hub floor ≥297 wDOGE) per runbook finding 2; opened as real-canonical-wDOGE code-path rehearsal, ≥150% CR at mint',
  'WUFF position liqPrice 70 K9USD/WUFF per runbook §4.2 intentional-sacrifice range (market 4,300× lower would need >1B WUFF)',
  'treasury tDOGE briefly 1.345 after fee burn (L1 regime ~12× baseline, preflight methodology bug); restored to 2.345 via 1.0 tDOGE deployer top-up',
];

writeFileSync(REG, JSON.stringify(reg, null, 2) + '\n');
console.log('registry updated:', REG);
