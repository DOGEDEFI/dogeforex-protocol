# DogeForex Protocol

DogeForex is a multi-currency protocol issuing **11 collateralized FOREX stablecoin instances —
K9USD, K9EUR, K9JPY, K9GBP, K9AUD, K9CNY, K9BRL, K9PKR, K9BDT, K9INR, K9NGN** — on **DogeOS** (Chikyū testnet, chainId **6281971**),
from ONE parameterized Frankencoin-fork codebase. Every instance is a full, isolated
Frankencoin-style system: token + equity pool shares + minting hub + positions + savings/leadrate.
The eleven instances share one audited bytecode set; only constructor arguments (name, symbol,
leadrate, bootstrap recipients) differ.

**K9USD (DogeForex Dollar) is the first instance** — deploy, Gate-3 rehearsal, and liquidity all
land on USD before the remaining six currencies follow with the same commands.

## Lineage

This codebase is a fork of the **OracleFreeDollar (OFD)** contract suite, which is itself a
pure-rename fork of **Frankencoin (ZCHF)** — the ChainSecurity-audited, battle-tested collateralized
stablecoin system (`oraclefreedollar/ofd` @ `mintinghub-v2`, commit `8368117`). DogeForex keeps
the audited contract identifiers (`OracleFreeDollar`, `Equity`, `MintingHub`, `Position`,
`Savings`, …) and all monetary constants for audit-diff proximity; the parameterization diff is
confined to the two token contracts:

- `OracleFreeDollar.sol`: `name`/`symbol` are constructor args (`TOKEN_NAME`/`TOKEN_SYMBOL`
  storage). Constructor: `(uint256 _minApplicationPeriod, string memory _name, string memory _symbol)`.
- `Equity.sol`: deployed inside the token constructor; its strings are derived —
  `string.concat(name, " Pool Share")` and `string.concat(symbol, "PS")` (K9USD → K9USDPS).
- `pure` → `view` on `name()`/`symbol()` is ABI- and selector-neutral (`0x06fdde03`/`0x95d89b41`).
- The EIP-2612 permit `DOMAIN_SEPARATOR` is `keccak256("EIP712Domain(uint256 chainId,address
  verifyingContract)")` — it carries **no name**, so renaming a token never invalidates existing
  `permit()` signatures. No separator change was needed.
- Note: solc 0.8.20 immutables must be value types, so the name/symbol fields are constructor-set
  storage rather than `immutable` (compiling equivalent of the design).

License: GPL-3.0 (inherited from Frankencoin via OFD).

## Architecture notes

**Genesis bootstrap (`contracts/GenesisBootstrapSale.sol`).** At genesis supply is 0, but the
MintingHub charges a 1,000-unit opening fee, `suggestMinter` costs 1,000 units, and the first
Equity deposit needs 1,000 units — the chicken/egg has no permissionless solution. The bootstrap
contract is registered once as a genesis minter via the token's deployer-gated `initialize()`
(the unavoidable bootstrap act; minter registrations are permanent, so safety is inertness by
construction): `execute()` mints the fixed genesis float exactly once — default 500k units split
100k pool seed / 250k equity / 50k challenger bounty / 100k incentives, recipients and amounts
immutable at construction — and can never mint again. `endTime` is a hard deadline: if execution
never happens, the float is forfeited forever (no unit can ever pay the 1,000-unit fees).

**Guardian admission gate (`contracts/GuardianTimelock.sol`).** OFD's two existential losses were
*admission* events and the veto mechanism fired zero times in two years. A guardian (the 3-of-5
Ops Safe) can therefore **pause admissions instantly** — `OracleFreeDollar.suggestMinter`,
`MintingHub.openPosition`, and `MintingHub.clone` revert while paused. Everything else — transfers,
minting on existing positions, repayments, withdrawals, savings, interest, challenges, auctions —
is **never pausable**. Unpausing and guardian rotation require enqueueing and waiting a **72h
timelock** (strictly shorter than the 14-day minter window and 5-day position init window). The
guardian address lives on the token (`setGuardian`, deployer-gated, one-shot); the hub reads it
via `ofd.guardian()`. A zero guardian address means the gate is fully open — identical to upstream
Frankencoin behavior.

## Repository layout

- `contracts/` — the protocol contracts (parameterized token + equity, minting hub, positions, savings)
- `contracts/GenesisBootstrapSale.sol` — one-shot genesis minter (bootstrap float allocations)
- `contracts/GuardianTimelock.sol` — 72h-timelocked guardian admission gate
- `test/` — the OFD/Frankencoin test suite, extended for parameterization, bootstrap, guardian
- `scripts/deployment/` — currency-agnostic hardhat-deploy tooling driven by `instances/instances.json`
- `scripts/deployment/instances/instances.json` — the 7-currency config surface (names, symbols,
  leadratePPM, guardian, bootstrap allocations); add real recipient/Safe addresses before mainnet

## Development

```bash
yarn install
npx hardhat compile   # solc 0.8.20, evm shanghai, optimizer 200 runs, no viaIR
npx hardhat test
```

## Deployment

Dry-run in-memory (no funds touched):

```bash
npx hardhat deploy --tags 00_deploy_all --network hardhat
```

Chikyū (chainId 6281971):

```bash
cp .env.example .env   # fill in RPC_URL_CHIKYU / CHIKYU_DEPLOYER_PK locally; never commit keys
npx hardhat deploy --tags 00_deploy_all --network chikyu        # core suite, all 7 instances
npx hardhat deploy --tags USD --network chikyu                  # USD instance only (core + bootstrap)
npx hardhat deploy --tags 06_genesis_bootstrap --network chikyu # genesis float minters
npx hardhat deploy --tags 07_guardian_timelock --network chikyu # guardian (needs guardian set in instances.json)
```

Deploy tags: `00_deploy_all` (Token → Equity auto → PositionFactory → PositionRoller →
Savings/Leadrate → MintingHub, plus the four genesis `initialize()` registrations),
`06_genesis_bootstrap`, `07_guardian_timelock`; per-currency filters (`--tags USD`) select exactly
one instance. After deploy, run the printed `npx hardhat verify --network chikyu ...` lines and
read back every contract on Blockscout before referencing addresses publicly.

Deployment order per instance (one deployer, sequential nonces, plain CREATE): Token (Equity lands
at deployer nonce+1 — always read `OFD.reserve()`) → PositionFactory → PositionRoller → Savings →
MintingHub → GenesisBootstrapSale → (post-Gate-3) GuardianTimelock. Tranche-1 equity: invest
exactly 1,000 units in the same session as deployment — the first deposit mints a flat 1,000 pool
shares for any size, and a front-run destroys the planned distribution.
