# DogeForex Protocol

DogeForex is a multi-currency protocol issuing **7 collateralized FOREX stablecoin instances —
K9USD, K9EUR, K9JPY, K9GBP, K9AUD, K9CNY, K9BRL** — on **DogeOS** (Chikyū testnet, chainId **6281971**),
from ONE parameterized Frankencoin-fork codebase. Every instance is a full, isolated
Frankencoin-style system: token + equity pool shares + minting hub + positions + savings/leadrate.

**K9USD (DogeForex Dollar) is the first instance** — deploy, Gate-3 rehearsal, and liquidity all
land on USD before the remaining six currencies follow with the same commands.

## Lineage

This codebase is a fork of the **OracleFreeDollar (OFD)** contract suite, which is itself a
pure-rename fork of **Frankencoin (ZCHF)** — the ChainSecurity-audited, battle-tested collateralized
stablecoin system. DogeForex keeps the audited contract identifiers (`OracleFreeDollar`, `Equity`,
`MintingHub`, `Position`, `Savings`, …) and constants for audit-diff proximity; what changes is
parameterization: token name/symbol are constructor arguments, so one audited bytecode set serves
all seven currencies (K9USD…K9BRL).

License: GPL-3.0 (inherited from Frankencoin via OFD).

## Repository layout

- `contracts/` — the protocol contracts (parameterized token + equity, minting hub, positions, savings)
- `contracts/GenesisBootstrapSale.sol` — one-shot genesis minter (bootstrap float allocations)
- `contracts/GuardianTimelock.sol` — 72h-timelocked guardian admission gate
- `test/` — the OFD/Frankencoin test suite, extended for parameterization, bootstrap, guardian
- `scripts/deployment/` — currency-agnostic hardhat-deploy tooling driven by `instances/instances.json`

## Development

```bash
yarn install
npx hardhat compile
npx hardhat test
```

Deploy dry-run (in-memory, no funds touched):

```bash
npx hardhat deploy --tags 00_deploy_all --network hardhat
```
