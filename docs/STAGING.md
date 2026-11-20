# Testnet staging deployment recipe

This runbook documents a repeatable Stellar Testnet staging deployment for the RevMarket HTTP backend (`backend/server.mjs`) and the resolution worker (`service/worker.mjs`). It covers startup configuration validation, optional AI drafting configuration, API/worker isolation, persistent database and evidence volumes, readiness verification, graceful shutdown, and backup rollback drills.

> [!IMPORTANT]
> Scope boundary: This recipe targets **Stellar Testnet staging only**. Production hosting, distributed multi-instance scaling, and Mainnet activation remain outside scope (`BACKEND_ENV=production` and `BACKEND_ENV=mainnet` are rejected at startup).

---

## 1. Startup configuration validation

`backend/server.mjs` validates all environment configuration via `resolveBackendConfig` (`backend/config.mjs`) **before** creating any directory, opening SQLite, or binding the HTTP listener.

- **Missing required variables** fail with exit code `1` and report **variable names only**:
  ```text
  Backend startup failed [CONFIG_MISSING]: Missing required configuration: APP_ORIGIN, BACKEND_DB, BACKEND_PORT
  ```
- **Invalid configuration values** fail with exit code `1` and report **variable names only**:
  ```text
  Backend startup failed [CONFIG_INVALID]: Invalid configuration: BACKEND_PORT
  ```
- Raw environment values and secrets (`PINATA_JWT`, `AI_API_KEY`, `RESOLVER_SECRET`) are never echoed to stdout or stderr.

### Backend API environment variables

| Variable | Local default | Staging (`BACKEND_ENV=staging`) | Validation and behavior |
|---|---|---|---|
| `BACKEND_ENV` | `local` | Required (`staging`) | Only `local` and `staging` are accepted; `production` and `mainnet` are rejected |
| `APP_ORIGIN` | `http://127.0.0.1:5173` | **Required** | Exact HTTP(S) origin with no path or credentials; non-loopback origins require `https:` |
| `BACKEND_DB` | `backend/data/revmarket.sqlite` | **Required** | Persistent SQLite file path on a private volume outside the web root |
| `BACKEND_PORT` | `3001` | **Required** | Integer `1`–`65535` |
| `BACKEND_HOST` | `127.0.0.1` | Optional (`127.0.0.1` or `0.0.0.0`) | Loopback by default; `0.0.0.0` inside a container when host port mapping binds `127.0.0.1` |
| `BACKEND_SHUTDOWN_TIMEOUT_MS` | `5000` | Optional (`5000`) | Drain timeout in milliseconds (`100`–`120000`) before forcing remaining connections closed |
| `SUPER_ADMIN_WALLETS` | `""` | Optional | Comma-separated valid Stellar Ed25519 `G...` addresses |
| `PINATA_JWT` | `""` | Optional | Server-only Pinata JWT without whitespace; required only for `/api/market-image` |
| `AI_ENABLED` | `false` | Optional (`false` or `true`) | Enables optional AI drafting assistance (`POST /api/drafts/:id/ai-assist`) |
| `AI_ENDPOINT` | `""` | Required when AI enabled | HTTPS chat completions URL (HTTP allowed only for loopback fixture testing) |
| `AI_API_KEY` | `""` | Required when AI enabled | Server-only model provider API key; no whitespace |
| `AI_MODEL` | `""` | Required when AI enabled | Non-empty model identifier recorded in `audit_events` |

### Manual drafting with AI disabled

- When `AI_ENABLED=false` (or when `AI_ENABLED` is unset and none of `AI_ENDPOINT`, `AI_API_KEY`, or `AI_MODEL` are set), the server starts with `aiConfig: null`.
- All manual drafting and review routes (`POST /api/drafts`, `PUT /api/drafts/:id`, `POST /api/drafts/:id/submit`, `POST /api/drafts/:id/withdraw`, `POST /api/drafts/:id/review`, `GET /api/review-queue`) work normally.
- `POST /api/drafts/:id/ai-assist` returns HTTP `503` (`{"error":"AI assistance is not configured"}`).
- If `AI_ENABLED=true` or any single `AI_*` variable is set while the others are omitted, startup fails immediately naming the missing `AI_*` variables (`AI_ENDPOINT`, `AI_API_KEY`, `AI_MODEL`).

---

## 2. API and settlement worker separation

The HTTP API (`backend/server.mjs`) and the resolution worker (`service/worker.mjs`) must run as separate OS processes (or separate containers) with distinct credentials and storage volumes:

| Boundary | Backend API (`backend/server.mjs`) | Settlement worker (`service/worker.mjs`) |
|---|---|---|
| Role | Off-chain SEP-53 sessions, activity reports, manual/AI drafts, reviewer workflow | Polls closed Testnet markets, gathers observations, writes evidence JSON, signs settlement txs |
| Signing keys | **None** (`RESOLVER_SECRET` is rejected at startup if present in the API environment) | Holds `RESOLVER_SECRET` for the single configured resolver `G...` account |
| External API keys | Optional `PINATA_JWT`, optional `AI_API_KEY` | None (queries HTTPS price/event endpoints in `EVENT_SOURCE_URLS`) |
| Persistent volume | `BACKEND_DB` (`/var/lib/revmarket/db/revmarket.sqlite` + `-wal`/`-shm`) | `service/evidence/<sha256>.json` and `service/attempts.sqlite` |
| Concurrency | Single process (SQLite WAL writer) | Single process per resolver account (prevents Stellar sequence collisions) |

---

## 3. Repeatable Testnet staging deployment

### Option A: Host process manager recipe (systemd / direct Node 22+)

1. Prepare isolated persistent directories outside the git checkout and outside the static web root:
   ```sh
   sudo mkdir -p /var/lib/revmarket/db /var/lib/revmarket/backups /var/lib/revmarket/evidence
   sudo chmod 700 /var/lib/revmarket/db /var/lib/revmarket/backups /var/lib/revmarket/evidence
   ```

2. Install locked dependencies from the repository root:
   ```sh
   npm ci
   npm run build
   ```

3. Start the backend API in staging mode with AI disabled (or supply `AI_ENABLED=true`, `AI_ENDPOINT`, `AI_API_KEY`, `AI_MODEL`):
   ```sh
   BACKEND_ENV=staging \
   BACKEND_HOST=127.0.0.1 \
   BACKEND_PORT=3001 \
   APP_ORIGIN=https://staging.revmarket.example \
   BACKEND_DB=/var/lib/revmarket/db/revmarket.sqlite \
   AI_ENABLED=false \
   npm run backend
   ```

4. Start the isolated resolution worker in a separate process environment (link or mount `/var/lib/revmarket/evidence` to `service/evidence`):
   ```sh
   CONTRACT_ID=CACP6QFWWZ7BBMDXB5KHC6AAQKE3HBQ4MFFZNNAIJWYK7P6GXJAMLHIN \
   RESOLVER_SECRET=<SERVER_ONLY_TESTNET_RESOLVER_SECRET> \
   STELLAR_RPC_URL=https://soroban-testnet.stellar.org \
   EVENT_SOURCE_URLS='[]' \
   npm run resolve
   ```

5. Expose readiness to the host and reverse proxy `/api` to `http://127.0.0.1:3001`:
   ```sh
   curl -fsS http://127.0.0.1:3001/api/health
   # {"status":"ok","service":"revmarket-api","version":1,"network":"testnet","automationEnabled":false}
   ```
   When combined with the W17 readiness endpoints (`#34`), configure the reverse proxy or supervisor readiness check against the readiness probe and liveness against process status while keeping `/api/health` enabled.

### Option B: Container Compose recipe (`deploy/staging/docker-compose.yml`)

```sh
APP_ORIGIN=https://staging.revmarket.example \
CONTRACT_ID=CACP6QFWWZ7BBMDXB5KHC6AAQKE3HBQ4MFFZNNAIJWYK7P6GXJAMLHIN \
RESOLVER_SECRET=<SERVER_ONLY_TESTNET_RESOLVER_SECRET> \
AI_ENABLED=false \
docker compose -f deploy/staging/docker-compose.yml up -d
```

- The `api` container binds `127.0.0.1:3001:3001` on the host, mounts `revmarket_staging_db` at `/var/lib/revmarket/db`, and exposes readiness at `http://127.0.0.1:3001/api/health`.
- The `worker` container mounts `revmarket_staging_evidence` at `/app/service/evidence` and never receives `AI_API_KEY` or `PINATA_JWT`.
- Restarting `api` (`docker compose -f deploy/staging/docker-compose.yml restart api`) delivers `SIGTERM`, drains in-flight requests, closes SQLite cleanly, and reopens `/var/lib/revmarket/db/revmarket.sqlite` with all committed rows intact.

---

## 4. Graceful shutdown, backup, and rollback procedure

### Graceful shutdown

When `backend/server.mjs` receives `SIGTERM` or `SIGINT`:

1. It immediately stops accepting new connections (`server.close()`) and closes idle keep-alive sockets (`server.closeIdleConnections()`).
2. In-flight HTTP requests finish within `BACKEND_SHUTDOWN_TIMEOUT_MS` (default `5000` ms).
3. Once connections drain (or the timeout elapses), `db.close()` runs once to close the SQLite WAL handle cleanly.

### Online backup and guarded rollback

Follow [BACKUP_RESTORE.md](BACKUP_RESTORE.md) against the staging database volume:

1. **Online backup** (while staging API is running):
   ```sh
   npm run db:backup -- --db /var/lib/revmarket/db/revmarket.sqlite --out /var/lib/revmarket/backups
   ```
2. **Verify restore** into an isolated directory (while staging API is running):
   ```sh
   npm run db:restore-verify -- /var/lib/revmarket/backups/revmarket-<UTC>-v3.sqlite --target /var/lib/revmarket/backups/verify-1
   ```
3. **Graceful shutdown and guarded promotion** (requires the API to be stopped so `http://127.0.0.1:3001/api/health` refuses connection and the exclusive SQLite lock succeeds):
   ```sh
   # Stop the staging API gracefully (SIGTERM / systemctl stop / docker compose stop api)
   npm run db:restore-verify -- --promote --target /var/lib/revmarket/backups/verify-1 --db /var/lib/revmarket/db/revmarket.sqlite --port 3001
   ```
4. **Restart and verify readiness**:
   ```sh
   curl -fsS http://127.0.0.1:3001/api/health
   ```
5. **Reverse rollback** (if needed): stop the API, move the promoted database and `-wal`/`-shm` aside, rename `<active>.pre-restore-<UTC>` back to `revmarket.sqlite`, and start the API.

---

## 5. Automated operational drill (`npm run staging:drill`)

Run the self-contained fixture drill from the repository root:

```sh
npm run staging:drill
```

What the drill exercises in an isolated temporary directory (`source: "fixture"`, no live Testnet RPC or external AI calls):

1. **Startup validation**: verifies that missing `APP_ORIGIN`, `BACKEND_DB`, `BACKEND_PORT` in `BACKEND_ENV=staging`, partial AI config (`AI_ENABLED=true` with missing `AI_ENDPOINT`, `AI_MODEL`), and a leaked `RESOLVER_SECRET` on the API each exit with status `1`, print variable names only, never echo secret values, and create no database file.
2. **Clean staging startup with AI disabled**: starts `backend/server.mjs`, checks host readiness on `GET /api/health`, completes SEP-53 wallet sign-in, creates and revises a manual draft, confirms `POST /api/drafts/:id/ai-assist` returns `503`, submits the draft, and exports a digest-verified settlement evidence file from the persistent evidence volume.
3. **Graceful shutdown and restart with AI wired**: stops the API gracefully, confirms the health probe is down, restarts `backend/server.mjs` against the same database volume with a local fixture AI endpoint wired via `AI_ENABLED=true`, `AI_ENDPOINT`, `AI_API_KEY`, `AI_MODEL`, verifies the prior draft and revisions survived intact, and exercises `POST /api/drafts/:id/ai-assist`.
4. **Rollback and shutdown drill**: takes an online backup with `createBackup`, applies an unwanted post-backup draft write, verifies the backup with `verifyRestore`, confirms `promoteRestore` is refused (`API_RUNNING`) while the API is up, gracefully stops the API, promotes the verified restore, restarts the API, verifies row counts and drafts match the pre-mutation snapshot, and shuts down cleanly.
