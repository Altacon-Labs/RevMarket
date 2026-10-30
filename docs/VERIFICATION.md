# Verification record — 28 October 2026

## Passed checks

| Check | Result and scope |
|---|---|
| `npm test` | 9 tests passed: median/spread/time policy, event agreement/binding, decimal precision, provider parsing and failures, worker persistence/restart behavior, Soroban wire encoding |
| `cargo test --locked --lib` | 11 tests passed against the native Soroban host and real Stellar Asset Contract implementation |
| WASM release build | `cargo build --locked --release --target wasm32v1-none` passed; compiled binary included at `artifacts/revmarket.wasm` |
| `npm run build` | Final React/Freighter production build passed |
| Headless Edge browser smoke | Desktop 1400px and mobile 390px: no JavaScript runtime errors or horizontal overflow; unconfigured contract blocks writes; create form renders. Screenshots included in this directory |
| Live price adapter probe | Coinbase, Kraken and Bitstamp returned valid ETH/USD data; public snapshot recorded in `PRICE_PROVIDER_PROBE.json` |
| Public Stellar testnet | Actual WASM upload, constructor deployment, native XLM stakes, worker settlement with deterministic fixture evidence, and actual payout passed. Public addresses/hashes recorded in `TESTNET_SMOKE.json` |
| Package integrity and preservation | ZIP CRC and per-file hashes checked; SHA-256 manifest included; original uploaded archive checksum unchanged |
| Secrets packaging check | No recognizable credential-pattern findings; Git history, private environment files, secret configuration and generated dependencies excluded. This is a pattern check, not a comprehensive security audit |

The contract suite covers the complete event escrow/payout slice, price greater-than and equality outcomes, invalid/duplicate/late predictions, missing/invalid markets, unauthenticated mutations, confidence/evidence/type guards, replay rejection, no-winner refunds, timeout refunds with/without requests, and payout rounding/market isolation.

The public testnet smoke used freshly generated accounts whose secret keys lived only in process memory. It did not access the user's wallet. The resolver ran the real transaction client and `processMarket` path with **deterministic event evidence fixtures**, not factual event feeds. It confirmed two 1-XLM deposits, winner payout of 2 XLM, claimed state and zero final escrow balance. Duplicate prediction, early request, loser claim and double claim were rejected. Testnet can reset; these public addresses are verification references, not a maintained deployment. The resolver key was not saved for ongoing use.

## Environment and reproducibility

Windows, Node 24.12.0, npm 11.7.0, Rust 1.99.1 (GNU host). Locked SDKs: Soroban 23.0.3, Stellar JS 17.4.0, Freighter API 6.0.1. The WASM build used a separate output directory for concurrency; the command and build profile are otherwise the same as documented. Use the supplied Cargo.lock: the initial unconstrained dependency resolution selected incompatible `ed25519-dalek` 3.0.0 for an older Soroban host; the delivered lockfile pins compatible 2.2.0. Native tests use `--lib` to avoid the Windows shared-library export limit. Doctests are disabled because there are no documentation tests in this crate.

Non-fatal build warnings: the Soroban SDK's legacy event publishing API is deprecated; Vite reports a JavaScript chunk over 500 KB. These did not prevent native tests, WASM compilation, production build or testnet execution.

## Not verified / still required

- Interactive Freighter approval, rejection, wallet switching and signing were not exercised with a real extension. The wallet API signatures were checked against the installed package, and the production bundle/browser startup were verified.
- No live factual event evidence providers were configured. Their schema, agreement and failure behavior were tested with fixtures.
- Live price providers were queried, but a real price market was not settled on testnet; price comparison was executed in native contract tests, and median submission was tested through a fake transport.
- Refunds were executed in native contract tests with advanced ledger timestamps, not by waiting 24 hours on public testnet.
- Storage restoration, long-running operations, load limits, provider outages, external CI execution and independent security review remain unverified.

See `LIMITATIONS.md` and `DRIPS_WAVE_BACKLOG.md` for the explicit remaining work. GitHub issues and Drips program submissions have not been published.

## Contribution-package refresh

The Wave application package adds an owner-authorized MIT license for the new implementation, retained-license notices, contribution/conduct policies, issue and PR templates, three bounded issue drafts, an application draft and a maintainer/publishing runbook. npm/Cargo license metadata and npm lock metadata were aligned. CI now has explicit read-only permissions, timeouts and Rust 1.99.1.

The existing 9 JavaScript and 11 native contract tests passed again after this preparation. The production frontend build also passed again using `npm exec --workspace frontend -- vite build --configLoader native`; the ordinary configuration bundler could not read an ancestor directory under the current machine's access restrictions. The native loader completed within the allowed project access without changing the frontend or its build output. Prior browser and testnet evidence remains the earlier recorded run, not a new live-network/wallet check.

Community-file presence, local Markdown links, package/license coherence, static issue-form/workflow structure and the compiled-WASM hash were checked; results are in `APPLICATION_CHECK.json`. The forms/workflow still require GitHub's hosted parsing/execution after publication. No hosted CI, issue publication, GitHub app installation or Drips approval is claimed by this local refresh.

## Stellar-only automation-planning refresh

Historical code and vendored historical libraries were moved outside the project and excluded from the new ZIP. Project documentation was rewritten around the Stellar architecture; the original upload remains unchanged, with its checksum in `SOURCE_PRESERVATION.json`. The new package is checked for historical contract files and obsolete chain integrations before delivery.

The app now renders a separate `AutomationPanel` with a local, non-persistent claim-plan preview. Enable and rule-based betting are disabled; the preview requests no wallet access and submits no transactions. A01–A04 define on-chain claim permissions, a separate executor, verified activation and later bounded-betting design. These are unfinished contribution tasks, not delivered execution features. The proposed first Wave is A01/F02/F03 (500 suggested points, subject to actual budget and approval).

After this refresh, all 9 JavaScript tests and 11 native contract tests passed again, and the production build passed with the native configuration loader. Headless Edge checked desktop and mobile layout, draft preview rendering, disabled automation activation and the absence of runtime errors. Updated screenshots are included. The unchanged contract artifact still matches the earlier passed testnet smoke; no delegated-automation or new live-wallet verification is claimed.

## Backend foundation

A local HTTP/SQLite backend and optional frontend activity panel were added. Eight new real-HTTP/SQLite tests cover request boundaries, SEP-53 signatures, challenge/session expiry and replay, private user isolation, activity deduplication, logout/deletion, rate limiting and database reopening/schema guards. Combined JavaScript/backend suite: 17 passing tests (the existing 11 native contract tests are unchanged). The frontend production build and emoji scan passed. The live local backend health and its frontend proxy are checked separately from temporary test servers. No real extension message-signing acceptance test, chain indexer, hosted deployment or automation executor is claimed.

The backend's data directory and SQLite files are excluded from the deliverable. `backend/README.md` documents the APIs, setup, expansion boundaries, public-key-auth limitations and experimental SQLite dependency. The unchanged contract artifact still matches the earlier testnet smoke record.

## Icon style

Selected regular-weight Phosphor SVG paths are bundled locally for wallet, refresh and automation, with their original MIT notice. Visible text labels are retained and decorative SVGs are hidden from screen readers. `npm run check:icons` scans authored source/config/documentation for emoji characters and is included in CI. The scan and production build passed for this update. No contract or transaction behavior was changed.
