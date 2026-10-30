# Drips Wave contributor backlog

This is the longer-term roadmap, not a batch to enroll in one Wave. Publish the three bounded [first-Wave issue drafts](issues/README.md) first; they cover claim-only permission work (A01) and selected parts of W07 and W06 without duplicating those themes. Repository approval, available budgets, issue enrollment and assignments must be confirmed in Drips. Maintainers select complexity points, not fixed dollar rewards; see [the Wave guide](WAVE_GUIDE.md). Sizes below estimate engineering effort, not Drips complexity: S roughly 1–2 days; M 3–5 days; L approximately 1–2 weeks. Split larger themes into independently valuable, reviewable outcomes before nomination.

Automation is staged in [AUTOMATION.md](AUTOMATION.md) and A01–A04 issue drafts. A01 is proposed for the first Wave; the executor and activation depend on its accepted API. Do not enroll dependent tasks before prerequisites are ready.

## W01 — Reproduce the deployed testnet vertical slice

**Priority:** P0 · **Size:** M · **Labels:** integration, testing · **Dependencies:** none.

The public-testnet create/stake/request/worker/claim path already exists in `scripts/testnet-smoke.mjs` and passed. Remaining work: adapt the harness to a controllable local network, include an event fixture service, and automate timeout/refund integration in CI. Do not nominate reimplementation of the completed public-testnet smoke as new work.

**Acceptance:** reproducible one-command script; actual contract/WASM and RPC rather than a JavaScript model; asserts balances, double-claim rejection and resolver authorization; documents transaction hashes and environment without storing secrets. CI can run against a local network.

## W02 — Verify authenticated provider reports on-chain

**Priority:** P0 · **Size:** L · **Labels:** soroban, security, oracle · **Dependencies:** W01.

First scope a reviewed threshold signer/report design bound to network, contract, market, close time, observation window and predicate. Document signer governance and key rotation. Only after accepting that design should maintainers nominate implementation as a separate task with bounded cost and replay tests.

**Acceptance:** malicious resolver alone cannot forge quorum; replay/wrong-domain/stale/duplicate-signer tests; bounded verification cost and explicit key-compromise model; review of backward compatibility and migration to a new contract instance.

## W03 — Implement real event evidence adapters

**Priority:** P1 · **Size:** L · **Labels:** service, oracle · **Dependencies:** none; W02 for production claims.

Choose a narrow supported event category and integrate two independently operated authoritative data feeds. Do not treat separate proxy hostnames or an LLM response as independent verification.

**Acceptance:** provider contracts/schema documented; time/market binding, unavailable/conflicting/incorrect responses tested; credentials server-only; provenance retained; unsupported questions clearly identified before users stake; fixture tests and one documented testnet resolution.

## W04 — Add durable scheduling and scalable market indexing

**Priority:** P1 · **Size:** L · **Labels:** service, infrastructure · **Dependencies:** W01.

Scope event ingestion/checkpoint recovery separately from durable resolution scheduling and account-sequence coordination. Account for missed blocks and public-testnet resets. Do not enroll the whole infrastructure theme as one week-long task.

**Acceptance:** checkpoint recovery, deduplication, finality handling, resolver account sequence serialization, backoff and bounded concurrency; restart/failure tests; price-window success measured under expected load; no duplicate successful settlements.

## W05 — Add storage restoration and maintenance UX

**Priority:** P1 · **Size:** M · **Labels:** soroban, frontend · **Dependencies:** W01.

Detect archived contract/market/position entries and prepare wallet-approved restoration and TTL extension transactions.

**Acceptance:** archived-entry integration test; read simulation cannot be mistaken for persisted renewal; restoration fees previewed; claimant funds/authorization preserved; operational monitoring instructions and regression tests.

## W06 — Publish and retrieve verifiable evidence

**Priority:** P1 · **Size:** M · **Labels:** service, frontend · **Dependencies:** none.

F03 is the initial local-file digest/binding verifier. Durable content-addressed hosting and remote retrieval are subsequent tasks; define backend and retention assumptions before nominating them. Do not duplicate F03 as another funded issue.

**Acceptance:** mismatch, missing blob, large body and unavailable host handling; no untrusted HTML rendering; server secrets excluded; storage backend and retention documented; local fixture works without paid accounts.

## W07 — Extend contract invariant and authorization coverage

**Priority:** P0 · **Size:** M · **Labels:** soroban, testing, security · **Dependencies:** none.

Add randomized pool/conservation tests, explicit mocked-auth success paths, nested token authorization assertions and long-lived TTL/restoration scenarios.

**Acceptance:** paid claims never exceed market deposits; refunds equal original stakes; cap/overflow boundaries; distinct markets cannot spend each other's accounting allocation; unauthenticated calls fail; tests catch intentionally introduced payout/auth faults. Independent review remains required.

## W08 — Restore richer React product features safely

**Priority:** P2 · **Size:** M · **Labels:** frontend, accessibility · **Dependencies:** none.

Nominate individual user outcomes, such as wallet-decline recovery or category browsing, rather than the entire original interface. Preserve exact integer balances and case-sensitive Stellar addresses. Keep notification persistence separate from detailed market presentation.

**Acceptance:** Stellar wallet and contract integration remain consistent; keyboard and small-screen flows tested; wallet switch/disconnect clears personal data; escaped content; no private IPFS keys in browser. Browser tests cover create, predict, declined signature and claim.

## W09 — Improve price observation guarantees

**Priority:** P1 · **Size:** L · **Labels:** oracle, service · **Dependencies:** W04.

Specify historical-time vs first-post-close pricing explicitly; add provider-native timestamps and documented fiat/quote conversion semantics.

**Acceptance:** no USD/USDT substitution without policy; exact decimal/rounding fixtures; stale/outlier/partial-source/clock-skew tests; published source independence and rate-limit assumptions; policy version committed in evidence and contract interface if needed.

## W10 — Verify deployment token and network configuration

**Priority:** P1 · **Size:** S · **Labels:** frontend, deployment · **Dependencies:** W01.

F01 covers native SAC, resolver and network validation with a new read-only config API. WASM hash attestation and full ABI-version compatibility checks are later work, to scope independently after F01. Do not nominate the full theme and F01 simultaneously.

**Acceptance:** wrong network, arbitrary 7-decimal token, wrong resolver and mismatched WASM/ABI produce actionable failures; no hardcoded production addresses; deployment can be reproduced from locked dependencies.

## W11 — Operate an approved contribution cycle (maintainer responsibility)

**Priority:** P2 · **Size:** S · **Labels:** documentation, community · **Dependencies:** maintainer program decisions.

MIT licensing, contribution policies, application copy, issue templates and initial issue drafts are now supplied. Remaining owner steps are publishing, getting hosted CI green, configuring a private reporting route, installing/syncing the Drips GitHub app, applying, and managing approved issues and reviews. This administrative theme is not a proposed first-Wave bounty.

**Acceptance:** real public repository and reviewer identified, hosted checks passing, live program approval/budget verified, approved complexity points set accurately, and issue completion checked during the active cycle. No fixed dollar commitments or invented assignments. Follow [APPLICATION.md](APPLICATION.md) and [MAINTAINER_RUNBOOK.md](MAINTAINER_RUNBOOK.md).
