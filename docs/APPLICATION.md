# Stellar Wave application package

Prepared on 28 October 2026. This document is a draft for the owner to use after publication; it does not assert program approval or a maintained deployment.

## Project description

RevMarket is an MIT-licensed testnet prediction-market implementation built with Rust/Soroban, React, Freighter and the Stellar JavaScript SDK. It demonstrates binary event and structured price markets using Stellar Asset Contract escrow, fixed closing times, authenticated resolution, proportional payouts and refund paths. A Node service gathers price observations or configured event evidence and records evidence digests with settlement.

## Why it belongs in the Stellar ecosystem

The active contract and transaction paths use Soroban authorization, persistent contract storage, native XLM SAC transfers and Stellar RPC. The frontend integrates Freighter. The project includes a deployable WASM and a public-testnet verification record. The application package is Stellar-only; historical code is preserved outside the delivery.

## Existing evidence

The project now also includes an optional local HTTP/SQLite activity backend, public-key challenge sign-in and a frontend activity panel. Eight HTTP/storage integration tests cover its core identity and privacy boundaries. Its records are explicitly unverified client reports. Verified ingestion and execution remain unimplemented placeholders in `backend/TODO.md`, not newly nominated contribution issues. The foundation must not be nominated as a new bounty.

- Eleven native Soroban contract tests and nine JavaScript tests passed during the migration.
- The production frontend build and desktop/mobile browser startup checks passed.
- A public-testnet smoke run uploaded/deployed the actual WASM, deposited two 1-XLM stakes, settled through the worker path using deterministic fixture evidence, paid 2 XLM to the winner, rejected invalid/repeated actions, and confirmed zero remaining escrow.
- `docs/TESTNET_SMOKE.json` contains public addresses and transaction hashes; `docs/VERIFICATION.md` identifies the scope and limitations. Temporary verification keys were not saved.

These results do not establish an audit, production readiness or real-world event-data accuracy. The committed workflow must also pass on the published repository; local results are not represented as hosted CI results.

## Initial contribution plan

The proposed first Wave has three bounded drafts: claim-only keeper permissions with on-chain opt-in, expiry and revocation (A01, High/200); exact authorization tests (F02, Medium/150); and local settlement-evidence verification (F03, Medium/150). Total proposed scope is 500 points, subject to review and confirmed available budget. A02 (executor), A03 (verified app activation) and A04 (bounded betting policy design) are staged follow-ups with explicit prerequisites. No fixed dollar amounts, funding or assignments are promised.

## Known limitations

This is testnet software. One resolver key is trusted. Real event resolution requires configured evidence providers. Interactive Freighter signing, automatic archival restoration, long-running scheduling, load behavior and independent security review remain work items. Price adapters were probed live, while a factual price market has not yet been settled in the public-testnet smoke. Full details are in `docs/LIMITATIONS.md`.

## Owner steps before submitting

Use the detailed [publishing checklist](PUBLISHING.md) to place the project at the repository root and avoid carrying over historical files or local development assets.

1. Publish this source at the intended public repository URL; choose the correct GitHub owner/org and default branch. No new public repository URL has been invented here.
2. Confirm the license scope and retained third-party notices, set the active reviewer, and configure the private security reporting route.
3. Get the repository's GitHub CI green and publish the remaining scoped issues. Do not nominate completed work.
4. Open [Drips Wave](https://www.drips.network/wave), follow [maintainer onboarding](https://docs.drips.network/wave/maintainers/participating-in-a-wave/), install/sync the GitHub app, and apply to the Stellar program.
5. Check the live program's requirements, dates, budgets and approval status. Enroll tasks only after approval.

## Suggested short application text

RevMarket is a testnet Soroban prediction-market project with Rust contracts, native XLM escrow, a React/Freighter frontend and an evidence-recording resolution worker. Its core create/stake/resolve/claim flow has executed on Stellar testnet; the repository includes contract and JavaScript tests, reproducible setup, MIT licensing, contribution policies, CI configuration and public verification evidence. We are seeking contributions to on-chain claim automation permissions, precise authorization testing and evidence verification. A non-operative planning preview is included in the app; delegation, background execution and automatic betting are not claimed as implemented. The project transparently documents its single-resolver trust model, fixture-based event verification and remaining production gaps. Our first proposed Wave consists of one High- and two Medium-complexity tasks, subject to program approval and available points budget.

Before pasting, verify that published CI has passed and that the owner can provide review capacity. Add the real repository URL in the application's dedicated field.
