# Local backend foundation

Node HTTP API with SQLite persistence and no new npm dependencies. Designed for a single local process, to expand later. It does not resolve markets, authorize on-chain actions, index the chain or execute automation.

## Run

From the project root, using Node 22.12+ (tested on 24.12.0):

```sh
npm ci
npm run backend
```

In another terminal:

```sh
npm run dev
```

Use `http://127.0.0.1:5173` exactly. The development server proxies `/api` to `http://127.0.0.1:3001`. Do not switch to `localhost` or a different port without updating APP_ORIGIN. Backend health is `http://127.0.0.1:3001/api/health`. Direct API writes also require the matching Origin header.

The example environment file documents options; set them in the process environment if needed (it is not auto-loaded). Defaults: BACKEND_PORT=3001; APP_ORIGIN=http://127.0.0.1:5173; database backend/data/revmarket.sqlite. BACKEND_DB can override its path. Set `SUPER_ADMIN_WALLETS` to comma-separated Stellar G-addresses for the super-admin network panel; the backend verifies the wallet against a signed session. Set `PINATA_JWT` on the backend to enable public IPFS image pinning; never place it in a frontend `VITE_*` variable. The Vite development proxy targets port 3001, so change its target when changing BACKEND_PORT.

The backend binds to loopback. Its terminal must keep running; Ctrl+C closes the listener and database. The launch command enables Node's experimental built-in SQLite API for Node 22 compatibility. SQLite may emit an experimental-feature warning. Keep the database directory writable and out of Git, ZIP deliveries and public hosting.

## Modules

- `server.mjs`: environment, local listener and shutdown.
- `app.mjs`: version-1 HTTP routes, signed challenges, sessions, validation and limits.
- `store.mjs`: SQLite schema version and persistence boundary. Add reviewed migrations when evolving the schema; newer databases are refused by older code.
- `frontend/src/lib/backend.mjs`: same-origin API and explicit Freighter message sign-in.
- `frontend/src/BackendPanel.jsx`: optional profile/activity UI. Market transactions continue through the Stellar wallet even if this service is offline.

## API

| Method/path | Access | Behavior |
|---|---|---|
| GET `/api/health` | Public | Readiness/version; automationEnabled=false |
| POST `/api/auth/challenge` | Matching Origin | `{wallet}`; short-lived sign-in text and challenge ID |
| POST `/api/auth/verify` | Matching Origin | `{id,signature}`; SEP-53 base64 signature; HttpOnly session cookie |
| GET `/api/me` | Session | Own public-key profile and creation/login timestamps |
| POST `/api/logout` | Matching Origin | Revoke current session and clear cookie |
| GET `/api/activity` | Session | Latest 50 own reported actions |
| POST `/api/activity` | Session + Origin | `{wallet,action,txHash}`; create/predict/request/claim only; deduplicated |
| DELETE `/api/me` | Session + Origin | Delete own profile, activity, sessions and outstanding challenges; chain data remains |
| GET `/api/admin/network` | Signed session + super-admin allowlist | Returns network availability; Mainnet remains unavailable until deployed and supported |
| POST `/api/market-image` | Signed wallet session + matching `X-Stellar-Wallet` header | Accepts one JPEG, PNG, or WebP up to 5 MB; pins it to public IPFS and returns its CID |

No user-list/admin, balance, betting, delegation-grant or automation-execution endpoint exists. The session is an off-chain identity convenience, not authority over escrow or wallet funds.

## Identity, privacy and trust

Users explicitly choose Sign in to activity after connecting Freighter. A [SEP-53](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0053.md) challenge binds the exact origin, public key, testnet context, nonce and expiry. Challenges expire after 120 seconds and are consumed on verification. Successful sessions expire after one hour; only token hashes are stored. Cookies are HttpOnly/SameSite=Strict, and Secure for HTTPS origins. Writes require an exact configured origin; no wildcard CORS is enabled.

This proves control of one Ed25519 public signing key. It is not SEP-10 authentication, does not validate current ledger signer weights, and does not support contract-account/multisig identity policies. It must never authorize financial actions. No private keys, KYC documents, email addresses or passwords are requested or stored.

Activity is explicitly `unverified_client_report`: an authenticated client can report any correctly formatted transaction hash. These records are not a ledger audit, account balance or proof of successful settlement. A separate chain indexer must verify transactions and derive positions before authoritative history is shown. Current positions and payouts remain contract reads. The API retains at most 1,000 reports per profile and exposes the latest 50; no pagination or export exists yet. Users can delete their off-chain profile; public ledger history cannot be deleted by this API.

## Limits and expansion

There is a basic process-local IP rate limit, 8 KiB JSON bodies, parameterized SQL and bounded request timeouts. Raw bodies, cookies and signatures are not logged. This is not a production internet-facing security posture: add TLS/same-origin routing, operational monitoring, distributed limits, account-auth review, backups, retention policy and deployment review before external exposure. Do not put a database under a static web root. Multiple instances and online schema migrations are not supported.

Future expansion is deliberately left in [TODO.md](TODO.md): verified history/indexing, account-auth review if needed, and on-chain permissions before any separate executor. A backend profile or message signature is never automation consent. Existing outcome resolution remains in `service/worker.mjs` with its separate resolver key. No new backend contribution issue is nominated by this foundation.

Run `npm test` for HTTP/SQLite integration checks. Tests cover signature tampering/replay, expiry, origins, identity isolation, deduplication, deletion/logout, body limits, rate limits and database reopening. Real interactive Freighter signing remains a manual acceptance step; automated tests use ephemeral keypairs only.
