# Migration and architecture summary

This repository is the active Stellar-only delivery for RevMarket. The original archived source remains outside the active implementation; its checksum is recorded in [SOURCE_PRESERVATION.json](../SOURCE_PRESERVATION.json). No historical source tree is bundled into this project.

## Scope of the active project

The live implementation is deliberately focused on the Stellar testnet workflow and contributor review process. The repository is organized by responsibility rather than a monolithic app layout:

- `contracts/market`: Soroban contract logic for market creation, prediction, request, settlement, claim, escrow accounting, and refund paths
- `shared`: Stellar RPC helpers, exact integer codecs, and reusable contract-call utilities
- `service`: off-chain evidence collection, policy checks, and worker logic for resolver-driven settlement
- `backend`: optional local API and SQLite-backed activity/profile storage
- `frontend`: React/Freighter client for market interaction, wallet connection, and position review
- `docs`: contributor guidance, deployment notes, verification expectations, and delivery boundaries

## Repository layout and package ownership

The root-level package manifest is intentionally kept as a thin workspace coordinator, not as a source of app logic. This allows a contributor-friendly developer workflow while keeping dependency ownership close to the app that uses it:

- the root `package.json` exposes shared commands and workspace orchestration
- `frontend/package.json`, `backend/package.json`, and `service/package.json` own their own dependency graphs
- the root `package-lock.json` records the combined npm workspace dependency graph and should be committed for reproducible installs; individual workspaces do not need separate npm lockfiles
- generated install directories such as `node_modules`, build output, and local caches remain ignored by version control

This pattern keeps the repo easier to manage for open-source contributors without breaking the standard local development flow.

## Separation of responsibilities

The design intentionally separates on-chain enforcement from off-chain observation:

- the contract authenticates the resolver and enforces settlement timing, evidence digest checks, and payout logic
- users authorize their own predictions and claims
- the worker gathers evidence and submits settlement instructions
- provider observations are operator-configured and are not treated as historical candle closes or independent consensus by default

This boundary is documented in [LIMITATIONS.md](LIMITATIONS.md) and should be treated as part of the active product contract.

## Migration intent

This project is not a migration of a broad historical codebase. It is a fresh, focused implementation for the Stellar workflow and contributor review process. The code is intentionally scoped around the primary market lifecycle:

1. create a market
2. stake on a side
3. request settlement after close
4. resolve using the configured resolver
5. allow winners or eligible users to claim
6. refund unresolved or no-winner paths when appropriate

## Automation status

Automation is intentionally staged and not enabled in the shipped application:

- claim-only on-chain permissions are a planned follow-up
- a dedicated executor is a later workstream
- UI activation for delegated automation is separated behind explicit verification

The current application only previews a plan. It does not send automated transactions and does not expose enabled delegation controls.

See [AUTOMATION.md](AUTOMATION.md) and the issue drafts in [docs/issues/README.md](issues/README.md) for the staged roadmap.

## Delivery boundaries

This project is intentionally limited to the Stellar implementation and the review-needed workflow around it. It does not claim broad production readiness, full decentralization, or feature parity with a larger ecosystem.

For contributors and maintainers, the important rule is simple: keep the active project boundary clear, preserve the source-preservation record, and do not smuggle historical implementation details into the live Stellar delivery.
