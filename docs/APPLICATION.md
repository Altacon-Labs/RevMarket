# Drips / Stellar submission draft



## Project description

RevMarket is an MIT-licensed, open-source prediction-market prototype built on Stellar using Rust/Soroban, React, Freighter and the Stellar JavaScript SDK. The current implementation supports binary event and structured price markets, 7-decimal token escrow, authenticated resolution, proportional pooled-stake payouts and timeout refunds. Its intended Testnet collateral is native XLM.

The repository includes a settlement worker that applies off-chain provider policies and persists evidence commitments, plus a local HTTP/SQLite backend for signed public-key sessions and explicitly unverified activity reports. The uploaded frontend also includes routed market pages, optional Privy integration, public IPFS image uploads and external asset charts. These additions require their own configuration and fresh acceptance checks.

RevMarket currently trusts one configured resolver key. It has no factory, tradable outcome shares, AMM, order book or active automated-claim executor. Our proposed development direction is community and admin market submissions, optional AI-assisted drafting, human-reviewed publication enforced by a factory, and isolated collateral-backed YES/NO share markets with an AMM. Work will be staged with accounting and authorization tests. This roadmap is not a claim of delivered exchange functionality.

The project aims to give Stellar developers a clear, extensible reference for escrow, market lifecycle and settlement verification. Contribution work will prioritize reproducibility, exact authorization, evidence verification and focused contract modules before broader trading functionality.

## Evidence and honest claims

The source archive contains a historical 28 October Testnet smoke record and a WASM whose SHA-256 matches that record. The recorded flow deposited two 1-XLM stakes, requested/settled an event using deterministic fixture evidence and paid the winner. It does not prove factual oracle accuracy or a maintained demo. Public contract and transaction references are in [TESTNET_SMOKE.json](TESTNET_SMOKE.json); the temporary resolver key was not retained.

Earlier records report eleven Rust tests and expanding JavaScript/backend test coverage. During this 31 October documentation review, eight dependency-free JS tests passed and two test files failed at import because dependencies were not installed. Full current tests/builds, interactive Freighter/Privy/image acceptance, hosted CI and network revalidation remain required. The archive lacks the `.github/workflows/` directory referenced by older notes. See [Verification](VERIFICATION.md) and [Source review](SOURCE_REVIEW.md). Do not publish older pass counts as fresh results.

No independent security audit, program acceptance, funded assignment, live mainnet deployment or production-readiness claim is made. The local backend, existing UI and existing contract are already supplied work, not new completed-work bounty nominations.

## Proposed initial contribution scope

Retain the existing A01/F02/F03 issue drafts as candidates, subject to reviewing their relevance against the actual baseline and current program budget:

| Candidate | Deliverable and acceptance | Dependency/status |
|---|---|---|
| F02: exact authorization tests | Wrong user/resolver and exact invocation-tree tests without blanket mocks; demonstrate denied unauthorized token movement | Existing draft; baseline reproduction first |
| F03: evidence verifier | Local exact-byte digest check bound to contract/market/rules; clear unavailable/mismatch results and malformed input tests | Existing draft; a digest match must not be labeled factual validation |
| A01: claim-only keeper permission | Explicit owner opt-in, expiry, revocation, user-only payout and negative permission tests; no betting authority | Existing draft; requires new contract/version and security review; no executor promised |

The prior suggestion totals 500 points (200/150/150). It is a planning estimate subject to the current program's approval and budget, not a reserved allocation or fixed currency reward. If A01 distracts from exchange foundations, maintainers should replace it with a bounded reproducibility/deployment task rather than nominate two overlapping scopes.

### Staged exchange contribution backlog

| Proposed issue | Bounded scope | Acceptance/dependency |
|---|---|---|
| B01 baseline reproduction | Lockfile install, full tests/builds, workflow, accurate evidence manifest | Public commit and passing hosted CI; do not claim prior missing workflow exists |
| V01 factory deployment | Version/hash registry, creator/reviewer authorization, role epochs, nonce invalidation/expiry, constructor deployment and discovery | Direct bypass/self-review/replay rejection, atomic rollback and actual child WASM tests; after baseline |
| V02 complete-set ledger | Split/merge, YES/NO balances, safe transfer, supply/backing invariants | Unauthorized mint/redeem rejection and property tests; approved data model |
| V03 AMM core | Reviewed integer buy/sell math and quotes with slippage/deadlines | Fee/reserve caps fixed, fuzz and conservation tests; after V02 and math review |
| V04 LP accounting | Proportional baskets, LP units, fee reserve and final exit | No double fee/redemption, dust/last LP rules fixed; after V03 |
| V05 resolution and app | Split into separate issues for resolver policy/timeout, verified indexer, then version-aware UI | Each issue has precise tests and independent review; not a single “build exchange” bounty |

Do not assign points or nominate all migration work before dependencies, acceptance criteria and review capacity are known. Retain `docs/issues/` as drafts until actual GitHub issues exist. A local draft or message is not an official assignment.

## Owner completion fields

| Field | Required before application |
|---|---|
| GitHub organization/repository | Actual public URL and ownership confirmation; not supplied/verified here |
| Maintainer | Public handle, private security reporting route, reviewer availability |
| Demo | Actual configured Testnet URL, supported paths and availability; no invented link |
| Release | Public commit/tag, hashes, license/attribution and fresh verification record |
| Issues | Published issue URLs with scoped acceptance and dependencies |
| Operations | Responsible resolver/TTL/evidence maintainer and incident runbook |

Suggested maintenance commitment: name a primary reviewer and backup, review contributor applications promptly, require reproducible financial/auth checks before merging, publish versioned releases and keep legacy claims available. This is a proposed commitment for the owner to adopt, not a service guarantee.

## Submission procedure and current-source reference

Check the active Stellar program in the [Drips Wave app](https://www.drips.network/wave). Official maintainer guidance describes onboarding the GitHub organization, installing its GitHub App, syncing public repositories and explicitly applying the repository to a relevant program. Repository approval precedes adding program issues. Confirm current budget, eligibility and terms there; this documentation does not establish an active cycle or approval. [Official maintainer onboarding](https://docs.drips.network/wave/maintainers/participating-in-a-wave/) (consulted 31 October 2026).

Before submission, replace owner fields, publish the reviewed source, verify hosted CI/demo, publish selected issues, and attach accurate evidence links. Do not submit the original archive without a secrets/licensing review. No GitHub installation, issue publication, application submission or outbound message has been performed by this documentation task.

## Community and AI authoring contribution track — proposed

The initial target welcomes submissions from ordinary users and admins. A human creator confirms AI-assisted wording; another authorized reviewer approves exact immutable rules before factory deployment. Resolver responsibility is separate. AI does not control signing keys, users' funds, publication approval or final settlement.

| Proposed issue | Scope | Acceptance/dependency |
|---|---|---|
| C01 drafts and review | Owned revisions, submission queue, non-owner review, reasons, audit trail and stale-write handling | Manual user/admin flows; isolation tests; schema migration review; after baseline |
| C02 AI assistance | Strict structured suggestions, source candidates, ambiguity/duplicate warnings and bounded request costs | User acceptance of suggestions, manual fallback, hostile-input/output tests; after C01 |
| C03 publication integration | Exact revision-to-rules binding, dual-authorized intent, expiry/role/nonce handling and confirmed deployment reconciliation | Real Testnet multi-party flow, no website bypass and no false confirmation; after C01/V01 |

These are new roadmap candidates, not completed features or funded assignments. Do not nominate overlapping work across C03 and V01; separate contract enforcement from service/UI integration. Prioritize baseline → manual drafts/review → bounded AI → factory enforcement before advertising AI-assisted on-chain publication. Retain the existing A01/F02/F03 work only where it fits reviewer capacity and the confirmed program budget. No new point allocation or reward promise is made.
