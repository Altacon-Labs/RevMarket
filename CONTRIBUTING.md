# Contributing to RevMarket

Thank you for helping improve RevMarket. This repository is a testnet Soroban prediction-market project with a Rust contract, a local backend, a React frontend, and an operator-run settlement worker. Before proposing changes, read the contributor map and the issue drafts so you understand the intended scope and any active constraints.

- [Contributor map](docs/CONTRIBUTOR_MAP.md)
- [Issue drafts](docs/issues/README.md)
- [Project limitations](docs/LIMITATIONS.md)
- [Automation architecture](docs/AUTOMATION.md)
- [Wave participation guidance](docs/WAVE_GUIDE.md)
- [Community conduct](CODE_OF_CONDUCT.md)

## Project overview

RevMarket is intentionally narrow in scope:

- Rust/Soroban contract for create, predict, request, settle and claim flows
- Stellar Asset Contract escrow and proportional payout logic
- worker-driven resolution and evidence handling
- optional local activity backend and frontend UI
- no automatic betting, delegated custody, or production deployment path by default

If a contribution changes financial rules, authorization, or settlement behavior, it must be explained and validated carefully. These are the highest-risk parts of the codebase.

## Local setup

Use the current supported toolchain:

- Node.js 22+
- Rust 1.99.1+
- `wasm32v1-none` target for Rust builds
- native C linker for contract tests
- on Windows: a current 64-bit GNU toolchain or MSVC build tools

Install and validate the repo in a fresh environment:

```sh
npm install
npm test
npm run build
npm run test:contracts
npm run build:contracts
```

Useful commands:

```sh
npm run demo            # offline fixture-driven demo
npm run backend         # local activity backend
npm run dev             # frontend development server
npm run test:testnet    # opt-in public testnet smoke flow
```

The contract scripts require Cargo on PATH. Use the committed lockfiles and do not regenerate Cargo.lock to bypass a build problem. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for wallet and deployment guidance.

## Contribution workflow

### 1. Pick a clear scope

For ordinary contributions, open or comment on a relevant issue before starting. Explain:

- the problem being solved
- your intended approach
- relevant experience or constraints
- the expected validation steps

Keep each PR focused on one user-visible problem. Avoid unrelated refactors, formatting churn, or broad cleanup in the same change.

### 2. Respect the project boundaries

Before proposing delegated automation or broader workflow changes, read [docs/AUTOMATION.md](docs/AUTOMATION.md) and the issue drafts. The project makes a clear distinction between:

- on-chain contract logic
- off-chain worker logic
- local app/backend activity
- planned automation features that are not yet active

Do not treat local profile activity or client-reported history as verified chain authority.

### 3. Use the repo’s rules for contribution quality

- Use the shared Phosphor SVG component for UI icons in the frontend.
- Do not insert emoji characters into authored code, configuration, or docs.
- Run `npm run check:icons` before submitting UI work.
- Preserve integer precision and case-sensitive Stellar addresses.
- Keep changes compatible with existing market semantics and trust boundaries.
- Contract ABI, storage shape, or settlement-policy changes require a migration plan and maintainer review.

### 4. Funded Drips Wave work

For funded Drips Wave work:

- apply through Drips and wait for official assignment before coding
- a local issue draft, label, or comment does not create a funded assignment
- confirm the current program status, points budget, and issue enrollment in Drips

Ordinary contributions outside Wave do not require enrollment and carry no implied payment.

## Pull request checklist

Before opening a PR:

- the change is scoped and explained in plain language
- the issue or task is linked appropriately
- the affected behavior is validated locally
- relevant failure cases are covered in tests
- the PR explains whether the tests use mocked transport, fixture evidence, or real RPC
- any trust, evidence, or security assumptions are documented

Use `Closes #<number>` only when the PR fully resolves the issue. Otherwise use `Refs #<number>` and clearly state what remains.

Include:

- the original problem
- the resulting behavior
- validation performed
- any material limitations or caveats
- screenshots for UI changes when relevant

Mark the PR as a draft while it is still in progress.

## Testing standards

The project expects meaningful validation, especially for financial, authorization, and settlement logic.

Run the relevant checks before submitting:

```sh
npm test
npm run build
npm run test:contracts
npm run build:contracts
```

When changing payment or settlement code, include tests for:

- valid and invalid outcomes
- timeout and refund paths
- duplicate or rejected actions
- auth enforcement and wrong-identity rejections
- evidence and confidence validation
- balance conservation and payout correctness

## Required safety rules

Never commit any of the following:

- `.env` files or runtime secret material
- private keys or wallet secrets
- identity documents
- sensitive worker evidence
- generated dependency folders
- test identities or seeded personal data

Public testnet transaction hashes are appropriate evidence. If you discover a security issue, report it through [SECURITY.md](SECURITY.md), not a public bug report.

AI-assisted work must be understood and tested by the submitter, and relevant attribution should be included where appropriate.

## Review and completion

Contributions are reviewed by the repository owner and maintainers. Contributors should raise blockers early and keep scope changes aligned with the agreed task. For Wave work, completion depends on the assigned issue being resolved during the active cycle, not merely on opening or merging a PR.

Maintainers use [docs/MAINTAINER_RUNBOOK.md](docs/MAINTAINER_RUNBOOK.md) to confirm completion and points status. Reward amounts are not guaranteed by this repository.

## License and attribution

Preserve the project’s license and copyright notices. New original contributions use the project’s MIT license.
