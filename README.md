# RevMarket — Stellar prediction markets

RevMarket is a testnet Soroban prediction-market prototype built around a Rust contract, a React/Freighter frontend, and an operator-run settlement worker. It demonstrates binary event markets and price-based prediction markets using Stellar Asset Contract escrow, fixed close windows, authenticated resolution, proportional payouts, and refund paths.

This repository is intended for local development, contributor review, and verification workflows. It is not presented as an audited production system.

## Quick links

- [Contributing guide](CONTRIBUTING.md)
- [Contributor map](docs/CONTRIBUTOR_MAP.md)
- [Issue drafts](docs/issues/README.md)
- [Deployment guide](docs/DEPLOYMENT.md)
- [Verification notes](docs/VERIFICATION.md)
- [Limitations](docs/LIMITATIONS.md)
- [License](LICENSE)
- [Attribution](NOTICE.md)

## Architecture

| Path | Purpose |
|---|---|
| `contracts/market` | Soroban contract: market creation, staking, settlement, claims, and escrow accounting |
| `shared` | Shared Stellar helpers and exact decimal encoding for contract calls |
| `service` | Provider adapters, evidence policy, worker logic, and retry-oriented polling |
| `backend` | Optional local API with signed public-key sessions and SQLite-backed activity data |
| `frontend` | React app for market creation, staking, positions, claims, and wallet interaction |
| `tests` | JavaScript and Rust verification for pricing, timing, payout, and worker behavior |
| `docs` | Setup, deployment, limitations, review notes, and Wave-related planning |

## Trust model and scope

RevMarket is intentionally transparent about its safety boundaries:

- one configured resolver key authorizes settlement outcomes
- the contract enforces timing, state transitions, and evidence digest checks
- worker/provider checks run off-chain and are not a substitute for a decentralized oracle
- automation and delegated claim execution are explicitly not active by default

This is a testnet prototype, not a production-grade decentralized oracle or a fully trustless market system.

## Prerequisites

- Node.js 22+
- npm 10+
- Rust 1.99.1+
- `wasm32v1-none` target for contract builds
- native C linker for Rust tests
- Stellar CLI for deployment workflows
- on Windows: a current 64-bit GNU toolchain or MSVC build tools

## Local setup

```sh
npm install
npm test
npm run build
npm run test:contracts
npm run build:contracts
```

Useful local commands:

```sh
npm run demo
npm run backend
npm run dev
npm run test:testnet
```

### Frontend and backend

Run the backend and frontend as separate processes:

```sh
npm run backend
npm run dev
```

Then open the app at http://127.0.0.1:5173. The local activity backend keeps profile and reported activity data in SQLite and does not grant automated permissions or wallet authority.

### Contract flow

The contract test suite exercises the real Soroban logic for:

- create market
- predict on both sides
- request settlement
- settle a market
- claim payout/refund

The demo script uses fixture observations only and does not write to a live chain.

## Testing

Run the project checks before submitting changes:

```sh
npm test
npm run build
npm run test:contracts
npm run build:contracts
```

Project-specific expectations:

- financial logic must preserve escrow rules and payout integrity
- authorization must reject wrong identities
- settlement timing and refund paths must remain valid
- UI and worker changes need meaningful validation, not just successful compilation

`npm run test:testnet` is an opt-in smoke test that deploys a temporary contract on Stellar testnet using temporary funded accounts. It is verification-focused and does not read a user's wallet or save secrets.

## Deployment and verification

Use [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for setup and environment variables. Use [docs/VERIFICATION.md](docs/VERIFICATION.md) for the intended verification steps and public evidence expectations.

Do not use production funds. Keep all secrets in local environment files or secret managers and never commit them.

## Contributor guidance

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes. For funded Wave work, follow the Drips assignment and issue guidance in [docs/WAVE_GUIDE.md](docs/WAVE_GUIDE.md). A local issue draft or comment does not create an official assignment.

## Security and operational notes

Read [SECURITY.md](SECURITY.md), [docs/LIMITATIONS.md](docs/LIMITATIONS.md), and [docs/VERIFICATION.md](docs/VERIFICATION.md) before running production-like or public-network workflows.

Important rules:

- never commit `.env` files or private keys
- never store sensitive evidence in the repo
- keep a single resolver worker per resolver account
- preserve evidence storage across worker restarts
- do not silently change settlement policy or trust assumptions

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

## About this repository

This repo contains the Stellar implementation only. Historical material is preserved outside the active project flow. The project is prepared for review, validation, and contributor-driven iteration, but it is not claimed to be fully production-hardened or externally audited.
