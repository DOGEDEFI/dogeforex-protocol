// P2 read-only status snapshot. Loads keys programmatically; NEVER prints key material.
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';

const RPC = 'https://rpc.testnet.dogeos.com';
const CHAIN_ID = 6281971;
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);

const keys = JSON.parse(readFileSync('/Users/tonicaradonna/.dogeforex/keys.json', 'utf8'));
const role = (n) => keys.roles[n];

const K9USD = '0x7cd12A6C4CbcfE87af588d9c3FF8576aB4FBF5A8';
const EQUITY = '0x61B9193ef708972D694f98DbBF2dA9ccfD614C4E';
const HUB = '0x0bADA8D887573Cc47eBef4ff5BBE42942B580F9b';
const MOFX = '0x2F0393CEb21b040722D36b628DB2C75aB0E0b156';
const WUFF = '0x03538800942cF78fb59550532496164D1d3bE31D';
const WDOGE_CANON = '0x5300000000000000000000000000000000000004';
const WDOGE_CUSTOM = '0xF6BDB158A5ddF77F1B83bC9074F6a472c58D78aE';
const WUFF_DEPLOYER = '0xB3b792aF28412722348D95EC19266805dd5B71f6';

const erc20 = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function totalSupply() view returns (uint256)'];
const C = (a, abi) => new ethers.Contract(a, abi, provider);

const fmt = (v, d = 18) => ethers.formatUnits(v, d);
const f4 = (v) => (Number(fmt(v)) < 0.0001 ? fmt(v) : Number(fmt(v)).toFixed(4));

const names = ['treasury', 'deployer', 'challenger', 'keeper', 'searcher', 'minter-bank', 'denybot', 'watcher'];
console.log('== native DOGE balances ==');
for (const n of names) {
  const b = await provider.getBalance(role(n).address);
  console.log(n.padEnd(12), role(n).address, fmt(b), 'tDOGE', Number(fmt(b)) >= 1 ? '(>=1 OK)' : '(LOW!)');
}
console.log('wuffDeployer ', WUFF_DEPLOYER, fmt(await provider.getBalance(WUFF_DEPLOYER)), 'tDOGE');

console.log('\n== token balances ==');
const t = (label, token, who) => C(token, erc20).balanceOf(who).then((b) => console.log(label.padEnd(28), f4(b)));
await t('treasury K9USD', K9USD, role('treasury').address);
await t('treasury MOFX', MOFX, role('treasury').address);
await t('treasury WUFF', WUFF, role('treasury').address);
await t('treasury wDOGE(canonical)', WDOGE_CANON, role('treasury').address);
await t('treasury wDOGE(custom)', WDOGE_CUSTOM, role('treasury').address);
await t('deployer MOFX', MOFX, role('deployer').address);
await t('wuffDeployer WUFF', WUFF, WUFF_DEPLOYER);

console.log('\n== protocol state ==');
const ofd = C(K9USD, [...erc20, 'function minterReserve() view returns (uint256)', 'function totalSupply() view returns (uint256)']);
console.log('K9USD totalSupply       ', f4(await ofd.totalSupply()));
console.log('K9USD minterReserve     ', f4(await ofd.minterReserve()));
const eq = C(EQUITY, [...erc20, 'function price() view returns (uint256)', 'function totalSupply() view returns (uint256)']);
console.log('Equity totalShares      ', f4(await eq.totalSupply()));
console.log('Equity price (e18)      ', (await eq.price()).toString());
const k9 = C(K9USD, ['function equity() view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
console.log('ofd.equity()            ', f4(await k9.equity()));
console.log('Equity K9USD balance    ', f4(await k9.balanceOf(EQUITY)));

console.log('\n== Equity.calculateShares preview for 19,000 K9USD ==');
const eqFull = C(EQUITY, ['function calculateShares(uint256) view returns (uint256)']);
const preview = await eqFull.calculateShares(ethers.parseUnits('19000', 18));
console.log('calculateShares(19000e18) =', fmt(preview), 'shares');

console.log('\n== existing Barkswap pools ==');
const factory = C('0xF3961157f56C983316657f0267B4C04460beE43f', ['function poolByPair(address,address) view returns (address)']);
for (const [label, tkn] of [['K9USD/customWDOGE', [K9USD, WDOGE_CUSTOM]], ['K9USD/canonWDOGE', [K9USD, WDOGE_CANON]], ['MOFX/K9USD', [MOFX, K9USD]], ['WUFF/customWDOGE', [WUFF, WDOGE_CUSTOM]]]) {
  const p = await factory.poolByPair(tkn[0], tkn[1]);
  console.log(label.padEnd(22), p === ethers.ZeroAddress ? '(none)' : p);
}
console.log('\ndone.');
