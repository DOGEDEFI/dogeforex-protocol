# IMF Protocol v2.0

IMF extends Frankencoin’s collateralized minting, challenge, savings, and pool-share governance mechanics to independent currency systems on DogeOS.

This repository contains the v2.0 smart contracts, tests, and deployment tooling for 11 parameterized instances: K9USD, K9EUR, K9JPY, K9GBP, K9AUD, K9CNY, K9BRL, K9PKR, K9BDT, K9INR, and K9NGN. Each instance has isolated token supply, pool shares, reserves, positions, savings, losses, and source-asset conversion accounting. There is no shared basket, cross-currency reserve, or FX-conversion oracle.

V2.0 uses fresh deployments. It does not upgrade or migrate the existing Chikyu v1 instances.

## Lineage and review scope

The behavioral baseline is Frankencoin V2 at `fa1457b9c2b370fbcecc5442ae4e0c51b62e454f`. The source-bridge decimal and credit behavior is a focused backport from Frankencoin at `8b4c4ab67bb361b91d58c474b87f4608fc4c0566`.

The intentional differences are:

- Parameterized token and pool-share names/symbols.
- Deployer-only genesis `initialize`, guarded by zero token supply and zero pool-share supply.
- A 100-unit minimum equity floor and the associated low-capital/recapitalization economics.
- A zero-vote governance fix using `<=`; qualification requires strictly more than 2% of time-weighted votes.
- Decimal-normalizing source bridges with redemption credits.
- Per-currency initial leadrates based on dated reference-yield evidence.

This is an independent implementation, not an official Frankencoin deployment. Existing upstream audits do not audit the v2.0 changes, DogeOS deployment, or source assets. Legacy Solidity identifiers and legally required provenance notices remain for diff review; they are not product-positioning claims.

## V2.0 mechanics

### Collateralized genesis

One shared **Test USDC (`tUSDC`)** is deployed first on Hardhat and Chikyu v2. It has six decimals, no real collateral value, and deployer-gated test minting. It is never an accepted production source asset.

For each currency, deployment registers five genesis minters through the deployer-only initialization path: Savings, PositionFactory, PositionRoller, MintingHub, and the source-asset bridge. There is no allocation minter, guardian, or guardian API.

The test bootstrap then performs ordinary protocol calls:

1. The first investor locks `100 × 10^6` raw tUSDC units in the currency’s bridge.
2. The bridge mints `100 × 10^18` raw local units—100 nominal local units.
3. The investor calls `Equity.invest(100 × 10^18, 1000 × 10^18)`.
4. Equity issues exactly 1,000 pool-share tokens. `Equity.price()` is then 0.3 local units per share.

This is only backing for the initial 100 local units held in Equity. It is not USD 100 worth of every currency at market FX rates, not backing for later position issuance, and not a protocol FX peg.

`MINIMUM_EQUITY` is 100 local units for initial investment, low-capital share issuance, and recapitalization. Lowering that shared threshold is an intentional economic change, not just a deployment parameter change.

### Admission and governance

There is no guardian, owner-controlled pause, replacement timelock, or administrative rate setter. New minters follow the public application/fee/veto path. New positions have a minimum three-day initialization period. The separate three-day savings interest delay is unchanged.

The deployer can call `initialize` only while both token and pool-share supplies are zero. Later governance uses qualified pool-share holders. The zero-vote comparison is `<=`, so an empty voting system cannot qualify a caller and exactly 2% is below the strict qualification boundary.

### Source-asset bridge

The same-chain bridge locks a trusted source stablecoin and mints an equal nominal number of local units:

- `mint`/`mintTo` accept source-token raw units.
- Local tokens use 18 decimals; `decimalMultiplier` converts source raw units to local raw units.
- `minted` and `limit` use local 18-decimal units.
- `burn`/`burnAndSend` accept local raw units and round down to a whole source-token unit. Any local remainder stays unburned with the holder.
- `burnAndCredit` records source-denominated redemption credit; `payoutCredit` pays it after any recipient restriction is lifted.
- New minting stops after 52 weeks. Redemption does not have the same expiration check.

Production requires a separately approved DogeOS stablecoin and a risk-reviewed per-currency cap. The asset’s issuer, upgrade, minting, pause, blacklist, decimals, ERC20 behavior, redemption, and liquidity assumptions are launch gates. Test tokens and deployer-minted mocks are not production reserves or collateral.

### Initial leadrates

`scripts/deployment/initial-leadrates.json` records the implementation-reviewed snapshot: a local-currency one-year sovereign reference yield plus **1.50 percentage points (15,000 ppm)**. EUR uses the ECB euro-area AAA one-year curve. Continuous rates and discount rates have explicit conversions; dated and secondary evidence remains marked provisional.

These values configure only the initial on-chain leadrate. There is no automatic rate oracle or administrator. Later changes follow qualified pool-share governance and the inherited seven-day delay. Production values require a fresh, signed-off snapshot before deployment.

The leadrate affects savings accrual and the baseline upfront cost of position minting. It does not create sovereign-bond income, guaranteed USDC returns, or guaranteed payment of the nominal savings rate; savings interest is limited by available protocol equity.

## Repository layout

- `contracts/` — token, Equity, MintingHub, positions, roller, savings/leadrate, and source bridge.
- `contracts/test/` — tUSDC and test-only fixtures.
- `test/` — inherited regression suite plus v2.0 bootstrap, bridge, governance, and position tests.
- `scripts/deployment/instances/instances.json` — 11 currency names, symbols, and initial leadrates.
- `scripts/deployment/initial-leadrates.json` — dated rate evidence and conventions.
- `scripts/deployment/networks.json` — network-specific source-asset configuration.
- `scripts/deployment/deploy/` — currency-agnostic deployment and bootstrap calls.
- `scripts/deployment/deployments/chikyuV2/` — separate v2 outputs when a testnet deployment is explicitly authorized.

Existing v1 deployment records and operational scripts are historical artifacts. Do not run v1 guardian or allocation-bootstrap flows against v2 contracts.

## Development

Use Node 20, pinned in `.nvmrc`, and the repository’s Yarn lockfile. The currently installed Hardhat version does not support Node 22 or 24.

```bash
nvm install
nvm use
yarn install --frozen-lockfile
npm test
npx hardhat compile --force
npx hardhat size-contracts
```

The compiler is solc 0.8.20 with the Shanghai EVM target, optimizer at 200 runs, and no viaIR.

Run the real in-memory deployment for all 11 currencies:

```bash
npx hardhat deploy --tags 00_deploy_all --network hardhat
```

This deploys tUSDC first and executes the full 100 tUSDC → 100 local units → 1,000 shares sequence for every instance, with postcondition checks. Select a single currency with its ISO tag, for example `--tags USD`.

## Chikyu v2 deployment gate

Live transactions require a separate explicit deployment approval. The internal `chikyuV2` network alias points to DogeOS Chikyu chain ID 6281971 but writes separate v2 deployment artifacts, leaving the `chikyu` v1 records intact.

Use Node 20 and configure the existing deployer key locally; never print or commit it. After approval:

```bash
npm run estimate:v2:usd
npm run deploy:v2:preflight
npm run deploy:v2:usd
```

The estimator quotes every contract at the same block, caches the oracle code read, and checks the total fee budget without broadcasting. It records an affordable estimate or the exact fee-regime blockers in `USD_Preflight.json` and refuses to continue to a probe when any ceiling is exceeded. Fee-triggered retries should wait between read-only estimates, not broadcast on a fixed timer; actual transactions remain sequential and receipt-checked. The preflight measures one zero-value native self-transfer, so it is also a live transaction. The deployment command forces compilation, runs preflight again, deploys only USD with `--tags USD`, checks on-chain state, requires Sourcify exact creation/runtime matches for all eight contracts, and records their Blockscout verification status. `npm run verify:v2:usd` retries the read-only state and source-verification checks without broadcasting another transaction. It exits unsuccessfully while any required source or explorer check is incomplete.

The provider-level guard sits below Hardhat’s local signer. It checks the signed chain ID, deployer and USD scope, the Chikyu L1-fee oracle at `0x5300000000000000000000000000000000000002`, and gas-price limits before every broadcast. Following the explicit higher-fee authorization for the USD Chikyu deployment on 2026-10-25, the L1 per-byte ceiling is five times the 0.000071 tDOGE reference rate; each transaction reserves twice its current L1 quote plus its maximum execution fee. The configured ceilings are 15 tDOGE per transaction, 50 tDOGE in total including probes, and 50,000,000 wei execution gas price. Actual L1+L2 receipts are reconciled and recorded. A missing L1 receipt field, unresolved pending transaction, duplicate nonce, or exceeded ceiling stops the run; these are safety limits, not spending targets.

`USD_Preflight.json`, `USD_V2Registry.json`, `USD_Verification.json`, and `feeGuard-USD.json` are written under `scripts/deployment/deployments/chikyuV2/`. The deployer retains all 1,000 initial shares. Verification includes a read-only position-factory call showing that 259,199 seconds is rejected and 259,200 seconds is accepted; it does not open a position or rehearse minting. The frontend remains unconfigured during this deployment step.

### USD Chikyu deployment record

USD V2 deployed on 2026-10-25: DogeOS Dollar (`K9USD`) is `0xBe01772ee4ba9807b4cF68F49E559d456d6f20cC`; the shared test-only six-decimal tUSDC is `0xAEFc8beD04F65cA1be38Ce76183f2b23E7f4165a`. The registry records the complete 100 tUSDC → 100 K9USD in Equity → 1,000 deployer-held pool shares bootstrap, five genesis minters, and the 59,400 ppm initial leadrate. Total tracked fees for the 16 deployment/bootstrap transactions and three diagnostic probes were 2.487499394268480206 tDOGE.

All eight contracts have Sourcify exact creation and runtime matches. Blockscout display verification remains an external blocker. On 2026-10-27, native standard-input submissions for all eight returned HTTP 200 (`Smart-contract verification started`) but none published `is_verified=true`; native multi-part and flattened-code diagnostics for TestUSDC also remained unpublished, and the Etherscan-compatible route returned `Fail - Unable to verify` for both minimal and full input. Its Sourcify integration is disabled and the documented verification-result websocket paths return 404. `USD_BlockscoutDiagnostics.json` records the attempts. `USD_Verification.json` remains incomplete until all eight display checks pass; the verifier now submits all eight before polling them together and never treats queue acceptance as success. No contract change or redeployment was performed.

After USD succeeds, rehearse bridge credits, positions, challenges, savings, and governance with separately authorized test transactions, then roll out the remaining instances with fresh fee preflights. Never use v1 addresses as v2 addresses.

Production launch additionally requires an independent audit, final source-asset approval and caps, refreshed rates, DogeOS mainnet parameters, initial-investor custody and distribution review, and legal review including MiCA. Removing the guardian alone does not establish decentralization or regulatory compliance.

## V1 rehearsal reconciliation

Run `npm run reconcile:v1:rehearsals` under Node 20 to refresh `deployments/chikyu.rehearsal-reconciliation.json` using only the public RPC and the preserved V1 registry/deployment artifacts. The reconciler uses 10,000-block event ranges and does not load keys, simulate writes, or broadcast transactions.

The snapshot at block 8,947,866 found that the scheduled challenge phases did not execute: all ten non-USD rehearsal positions have zero minted debt and no mint, challenge-start, or terminal challenge events. EUR remains admission-paused because the scheduled unpause has no `Unpaused` event and `paused()` is still true. The V1 USD bridge has 31,500 units currently minted; the other ten V1 bridges remain unregistered with zero minted. These are incomplete operations, not evidence of a contract failure. Executing any missing unpause, mint, challenge, bid, or bridge step requires separate authorization.

License: MIT. See `LICENSE` and the provenance notices in `NOTICE.md` and per-file SPDX headers.
