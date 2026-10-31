# Deployment and operations

> Documentation review: 31 October 2026. Source: `RevMarket22.zip`. **As-is** means present in inspected source, not independently proven in production. **Proposed v2** means design only; no v2 contracts or deployment are delivered.


## Release scope and prerequisites

This guide applies to the extracted source repository. This documentation ZIP contains no new executable contract or hosted service. Use Testnet only with the current client. Keep `package-lock.json` and `contracts/Cargo.lock`; use `npm ci` for a clean dependency installation. Node must satisfy >=22.12.0; historical evidence used 24.12.0. Rust needs the workspace's pinned Soroban 23.0.3 dependency, a native linker and `wasm32v1-none`. Rust 1.99.1 is a historical recorded toolchain, not an independently validated minimum. Record actual versions before reproducing.

The uploaded archive has no `.github/workflows/` directory despite older docs describing CI. Add and validate a workflow in the published repository before claiming CI. Do not assume bundled build caches establish reproducibility.

### Frontend configuration corrections for this archive

The current UI adds `VITE_PRIVY_APP_ID` and `VITE_IPFS_GATEWAY`. Privy integration is conditional in `frontend/src/main.jsx`, but primary Freighter connection buttons are only rendered for authenticated users. With no Privy ID, reads using `VITE_READ_ACCOUNT` can work, but the main sign-in/connection journey is blocked. To exercise the current UI, configure your own Privy app and allowed origin; alternatively implement and test direct Freighter access as the M0 correction. That correction is not implemented by these docs.

Use public-only build values:

| Variable | Scope and behavior |
|---|---|
| `VITE_CONTRACT_ID` | Current manager C-address; missing/invalid client configuration produces read-only preview mode |
| `VITE_RPC_URL` | HTTPS RPC; default Testnet endpoint |
| `VITE_READ_ACCOUNT` | Public funded G-address for disconnected simulations; no key required |
| `VITE_PRIVY_APP_ID` | Public app ID for current login-gated interface; configure origin in your provider account |
| `VITE_IPFS_GATEWAY` | Public HTTPS image gateway; default `https://gateway.pinata.cloud/ipfs` |

Frontend build values are public and generally fixed at build time. Rebuild when changing them. No user email login or Privy session can sign the Stellar market transactions in this implementation.

### Backend configuration

Set environment values in the backend process; its `.env.example` is documentation and is not automatically loaded. `npm run backend` listens on `127.0.0.1:3001`. Defaults: `APP_ORIGIN=http://127.0.0.1:5173`, database `backend/data/revmarket.sqlite`. `BACKEND_PORT`, `BACKEND_DB`, `SUPER_ADMIN_WALLETS` and server-only `PINATA_JWT` are supported. The Vite proxy target must match the selected backend port. Use the exact origin, not `localhost` as an interchangeable name.

Pinata is needed for the UI's event image-upload path; backend signed-wallet authentication and matching upload wallet are required. Images are public IPFS content. Price creation without an image does not need pinning. Test session sign-in separately from Privy app login and chain signing. Back up SQLite privately; it stores unverified reports and is not the authoritative ledger.

### Hosting requirements

Serve the built frontend with HTTPS, SPA fallback for React Router paths and a same-origin `/api` reverse proxy to the loopback backend. Do not serve SQLite or evidence private files under the static root. Configure Privy for the real origin, exact backend origin, secure cookies, TLS, image upload size/time limits, rate limits and a funded dedicated worker. The source does not supply a production hosting stack, distributed sessions, indexer or multi-instance deployment.

Validate a deep link, login, wallet refusal/account switching, image upload rejection/success, chain confirmation and backend outage before sharing the demo. A static deploy alone does not establish backend/image functionality. A signed super-admin session only reveals network availability; it cannot enable mainnet in this client.

## Existing Testnet contract and worker procedure


This document explains how to build, deploy, and operate the RevMarket Stellar delivery on testnet without relying on hidden assumptions or local-only configuration.

## 1. Build and deploy

Install Rust and the official Stellar CLI using the official Stellar setup guide. Use testnet keys only. The generated local identities contain secrets and must never be committed to the repository or included in a ZIP.

```sh
stellar keys generate deployer --network testnet --fund
stellar keys generate resolver --network testnet --fund
stellar keys address resolver
cd contracts
rustup target add wasm32v1-none
cargo test --locked --lib
cargo build --locked --release --target wasm32v1-none
stellar contract id asset --asset native --network testnet
```

Record the public resolver address and the native Stellar Asset Contract ID printed by the CLI, then deploy the contract with the required constructor arguments:

```sh
stellar contract deploy --wasm target/wasm32v1-none/release/revmarket.wasm --source-account deployer --network testnet -- --token NATIVE_SAC_C_ADDRESS --resolver RESOLVER_G_ADDRESS
```

Important implementation constraints:

- the constructor verifies 7 decimal places on the configured token
- this deployment procedure uses native XLM SAC; the constructor itself accepts any token reporting 7 decimals and does not prove native-asset identity
- the token and resolver are immutable in this release
- to rotate, deploy a new instance and leave the old instance available for claims or refunds
- if the installed Stellar CLI differs from the command expectations, check the version-specific help output before running a deployment command

This package does not ship a bundled Stellar CLI binary.

## 2. Configure the frontend

Copy the example frontend environment file and set the deployed contract address:

```sh
cp frontend/.env.example frontend/.env
```

Set the following values in the frontend environment:

- `VITE_CONTRACT_ID`: deployed C-address for the market contract
- `VITE_READ_ACCOUNT`: optional public funded testnet G-address for disconnected reads
- `VITE_*`: public values only, never a private key

The default RPC is `https://soroban-testnet.stellar.org`.

Then run:

```sh
npm run dev
```

In Freighter, select Stellar Testnet and fund a wallet with Friendbot. The app checks the selected account and network before each signature. Reads are simulated; mutations simulate, prepare, sign, submit, and then poll for a confirmed success result.

Timeout and failed transaction messages include a transaction hash. Check the hash before retrying. This prototype client rejects transaction fees above 1 XLM.

The app displays the latest 50 markets and uses the on-chain creator and position records for personal filters. It polls Stellar RPC for updated state. If a transaction confirms just before a later refresh fails, it may still have succeeded; inspect the transaction hash before assuming it failed.

## 3. Run the resolution worker

Set the worker environment variables in your process manager or local shell. The following values are used:

| Variable | Meaning |
|---|---|
| `CONTRACT_ID` | deployed market C-address |
| `RESOLVER_SECRET` | resolver secret for the configured resolver G-address; server-only |
| `STELLAR_RPC_URL` | optional HTTPS testnet RPC endpoint |
| `EVENT_SOURCE_URLS` | JSON array of 2–5 operator-configured evidence endpoints on distinct hosts |
| `RUN_ONCE` | set to 1 for a single scan; otherwise the worker scans every 10 seconds |

Start the worker:

```sh
npm run resolve
```

Operational requirements:

- run one process per resolver account
- parallel workers can collide on account sequence numbers
- the worker scans at most 1,000 markets
- it requests closed markets, gathers evidence, writes exact JSON under `service/evidence/<sha256>.json`, and submits settlement
- it checks state before sending and again on each rescan
- failed or inconclusive sources defer resolution rather than guessing
- use a dedicated scheduler or indexer before increasing volume

Evidence providers are configured by the operator, never by the market question text. The worker adds a `?marketId=<integer>` query parameter to each event endpoint and expects a response like this:

```json
{
  "marketId": 4,
  "questionHash": "SHA256_OF_JSON_STRINGIFIED_EXACT_QUESTION",
  "outcome": 0,
  "confidence": 9000,
  "observedAt": 1793190000,
  "evidenceUrl": "https://publisher.example/evidence/4"
}
```

Important interpretation rules:

- `outcome`: 0 means YES, 1 means NO
- `observedAt`: integer Unix seconds after closing, no more than 1 hour old, and no more than 5 seconds in the future
- `confidence`: integer basis points in the 8000–10000 range
- question hashing is `createHash('sha256').update(JSON.stringify(question)).digest('hex')`
- hostnames identify providers, but separate hosts do not prove independent ownership
- response-provided `source` is ignored
- redirects and non-HTTPS endpoint URLs are rejected
- the service checks the evidence URL scheme but does not fetch, verify, or authenticate the remote content

Endpoint operators must provide truthful and independently verified facts. Do not connect untrusted proxies.

## 4. Manual smoke test

Follow this sequence to validate the flow end-to-end:

1. Create a price market that closes in 2–3 minutes and start the worker before close.
2. Use two funded Freighter test accounts to take opposite positions.
3. After close, confirm new predictions are rejected and the request status appears.
4. Confirm settlement and locate the matching evidence file. The SHA-256 over its exact bytes must match the on-chain digest.
5. Claim with the winning account and compare balances before and after, allowing for XLM transaction fees. A second claim must fail.
6. For event markets without configured providers, verify abstention; after close plus the 24-hour period, claim the refund path.

Manual Freighter signatures and real public API behavior are separate from automated unit tests. See [VERIFICATION.md](VERIFICATION.md) for the local verification work performed in this repo.

## 5. Storage lifecycle and TTL notes

Writes extend the instance, market, and touched position TTL toward 1,036,800 ledgers, roughly 60 days at 5 seconds per ledger. Simulation reads do not persist these extensions.

Submit `keepalive(id, user)` periodically for positions that still need a claim. It extends the relevant entries without requiring the user’s signature. Operators pay storage fees.

Once entries are archived, they must be restored using Stellar restoration tooling before this client can use them; automatic restoration is not implemented. Back up contract IDs, claimant addresses, and evidence, and monitor TTLs and resolver balance.

## References

- [Stellar JS SDK](https://github.com/stellar/js-stellar-sdk)
- [Soroban SDK](https://docs.rs/soroban-sdk/23.0.3/soroban_sdk/)
- [Freighter API](https://github.com/stellar/freighter/tree/master/%40shared/api)
- [Stellar storage documentation](https://developers.stellar.org/docs/build/smart-contracts/storage/persisting-data)

## Proposed v2 deployment sequence — unavailable until implemented

1. Pass baseline and v2 verification gates; choose collateral, fee/reserve caps, immutable rules and resolver policy. Approve final ABI and math review. Build from a reviewed commit and record code hashes, toolchain/lockfile versions and network passphrase.
2. Upload child market WASM, deploy the factory with the disclosed operator address, approve a unique version/hash, configure reviewer roles/epochs and confirm creation is initially paused. Record operator control and recovery policy without publishing keys.
3. Enable creation for the test, collect independent creator/reviewer authorization for exact hashed params, nonce, expiry and role epoch, create a child, and verify derived address, initialized state, registry entry and isolated escrow. Failed constructor/deployment must leave no partial registry or transfers.
4. Seed balanced liquidity, test both-side buys/sells, complete-set merge, LP basket withdrawal, request/settle, timeout Invalid handling and final redemption. Reconcile supplies, locked collateral and fees from actual chain data.
5. Deploy and reconcile a persistent version-aware indexer. Configure separate legacy/v2 addresses in the app only once such configuration support is implemented; the current single `VITE_CONTRACT_ID` cannot route v2 methods.
6. Test restored archived state, evidence retrieval, provider failures, operator outage, stale quotes and backend/indexer outages. Verify creation pause leaves redemption possible.
7. Publish a manifest containing network, commit, factory/child/token addresses, WASM hashes, operator/resolver public addresses, rules/policy hashes, fee/cap values, deployment transaction hashes and verification evidence. Never publish secrets or imply test addresses are mainnet.

### Legacy maintenance and incident handling

Retain old contract addresses, evidence and user claim routes. Monitor code/instance/persistent TTL and fund maintenance for unclaimed positions. Do not migrate pooled balances by an administrator; users exit under old rules. During a resolver outage, publish that timeout refunds are available strictly after deadline, and preserve the ability to submit them. During suspected dishonest resolution, the current contract has no reversal or dispute function; preserve evidence and disclose affected markets.

Rollback is an application/version-routing decision and a stop to new factory creation where supported. It cannot reverse confirmed transactions. Avoid retrying a timed-out transaction until its hash and final status are checked. Maintain worker account sequence discipline and back up exact evidence bytes before submitting.

## AI-assisted community creation deployment — proposed prerequisites

Deploy authoring/review services only after reviewed database migrations and baseline tests. Separate configuration for model provider credentials, model identifier, request/token budget, per-wallet rate limits, source-retrieval allowlist, request timeout, draft retention and audit retention. These are configuration requirements, not environment variables already supported by the source. Choose exact names during implementation and document them with examples that contain no secrets.

Keep AI provider keys server-side and separate from resolver and transaction-signing keys. Do not put a creator or reviewer secret in the AI worker. Disable arbitrary model tool calls; retrieve evidence through the bounded service boundary. Disclose external model processing and require confirmation before transmitting draft content. Manual creation and review must work when the AI service is down.

Bootstrap a disclosed factory operator and at least one active reviewer whose address differs from the creator. Backend reviewer identity must be reconciled to on-chain role state/epoch before preparing publication. Do not infer reviewer powers from `SUPER_ADMIN_WALLETS`; that existing option governs only the current network-status endpoint. Test multi-party Freighter/authorization collection against the pinned SDK and actual Testnet before calling it supported.

The release exercise must cover a manually authored user market, an AI-assisted user market and an admin-authored market reviewed by another wallet. Check changed revision, self-review, removed reviewer, expired authorization, invalidated nonce and direct factory bypass attempts. Each must either deploy the exact approved rules or fail without partial state/funds movement. Publish a market as tradable only after liquidity is verified.

If this workflow is demonstrated against legacy v1, label approval as website moderation only: direct on-chain creator calls still work. Enforced reviewed creation requires the new factory. During an AI outage, fall back to manual drafting; during reviewer outage, keep drafts pending. Neither outage should freeze existing trades, claims or redemptions.
