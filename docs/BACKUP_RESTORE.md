# SQLite backup and restore

This runbook covers the local backend database (`backend/data/revmarket.sqlite`, or the path in `BACKEND_DB`). It applies to the single-process local backend described in [backend/README.md](../backend/README.md). It does not cover worker evidence, contract state or any hosted deployment.

## Why a file copy is not a backup

The backend opens SQLite in WAL mode. Recently committed transactions live in `revmarket.sqlite-wal` until SQLite checkpoints them into the main file. Copying `revmarket.sqlite` (or even the three files one after another) while the API runs can produce a file that is missing commits or is internally inconsistent.

`npm run db:backup` uses `VACUUM INTO`. SQLite runs it as one read transaction, so the new file is a transactionally consistent snapshot of every commit that existed when it started, including commits still in the WAL. Writers are not blocked and the API keeps running. The library uses `VACUUM INTO` rather than `node:sqlite` `backup()` so it keeps the repository's Node `>=22.12.0` minimum.

## Commands

All commands run from the repository root. The end-to-end recovery rehearsal (`npm run db:drill`) exercises these commands against a disposable database; its results are fixture measurements and do not replace the live checks listed in the rehearsal report.

## Release rehearsal scope

The restart and recovery rehearsal covers: draft review on a disposable database, worker interruption after submission, API restart and reconciliation, and backup restoration with row-level agreement against expected outcomes. RPC is mocked with a controllable transport and fixtures are synthetic. Each run writes a report that labels every result as `fixture` (mocked RPC and synthetic data) or `live` (real Testnet). Live Testnet smoke checks are kept separate and are not part of the rehearsal command; they remain open until run against Testnet. They print one JSON line on success. On failure they print one line, `db:<command> failed [CODE]: <message>`, to stderr and exit 1.

### 1. Back up (API may keep running)

```sh
npm run db:backup -- --out /secure/revmarket-backups [--db <path>]
```

- `--db` defaults to `BACKEND_DB`, then `backend/data/revmarket.sqlite`, exactly like `backend/server.mjs`.
- The output directory must already exist. A warning is printed if it is inside the repository.
- The snapshot is written to a hidden `.partial` file first. It is checked with `PRAGMA integrity_check`, hashed, and only then published as `revmarket-<UTC time>-v<schema>.sqlite`, for example `revmarket-2026-11-19T10-22-05Z-v2.sqlite`. An existing file is never overwritten, and a failed run leaves no file with a final name.
- A manifest is written next to it, `revmarket-<UTC time>-v<schema>.manifest.json`:

  ```json
  {"format":1,"file":"revmarket-2026-11-19T10-22-05Z-v2.sqlite","sha256":"...","bytes":4378624,"userVersion":2,"createdAt":"2026-11-19T10:22:05.123Z","tables":{"drafts":5058,"draft_revisions":10114,"...":0},"method":"VACUUM INTO"}
  ```

  The row counts and hash are taken from the backup file, not from the live database.

Error codes: `SOURCE_NOT_FOUND` (no database is created), `SOURCE_NOT_SQLITE`, `OUT_DIR_NOT_FOUND`, `BACKUP_FAILED`, `BACKUP_INTEGRITY_FAILED`, `SCHEMA_UNSUPPORTED`, `BACKUP_EXISTS`, `USAGE`.

### 2. Verify a restore into a clean location (API may keep running)

```sh
npm run db:restore-verify -- /secure/revmarket-backups/revmarket-2026-11-19T10-22-05Z-v2.sqlite --target /secure/restore-check-1
```

The target must not exist yet; it is created with mode 0700. The backup is copied to `<target>/revmarket.sqlite` and every check runs on that copy:

| Check | Fails with |
|---|---|
| Copy sha256 equals the manifest and the source backup | `HASH_MISMATCH` |
| SQLite header and readable schema | `NOT_SQLITE` |
| `PRAGMA integrity_check` returns `ok` | `INTEGRITY_FAILED` |
| `user_version` is between 2 and the version this backend supports, equals the manifest, and the draft/review tables exist | `SCHEMA_UNSUPPORTED` |
| `PRAGMA foreign_key_check` is empty | `FOREIGN_KEY_VIOLATION` |
| Every `drafts.current_revision_id` points to a revision of the same draft; every review decision's revision belongs to its draft; revision numbers are integers >= 1 and unique per draft | `REFERENTIAL_MISMATCH` |
| Row count of every table equals the manifest | `ROWCOUNT_MISMATCH` |

Other codes: `TARGET_EXISTS`, `TARGET_PARENT_NOT_FOUND`, `BACKUP_NOT_FOUND`, `MANIFEST_NOT_FOUND`, `MANIFEST_INVALID`.

The result is written to `<target>/verify-report.json` with `ok`, each check's status, sha256, schema version, table counts and a small sample (up to five draft ids with status, current revision number, revision and decision counts). The report never contains wallet addresses, questions or session hashes. A failed verification writes the report with `ok: false` and the error code. Use `--manifest <file>` if the manifest is not next to the backup.

Verification never opens or changes the active database.

### 3. Promote a verified restore (API must be stopped)

```sh
# stop the API first (Ctrl+C in its terminal, or stop the service)
npm run db:restore-verify -- --promote --target /secure/restore-check-1 [--db <path>] [--port <n>]
```

Promotion refuses to start unless all of these hold:

- `<target>/verify-report.json` says `ok: true` and its sha256 still matches `<target>/revmarket.sqlite` (`NOT_VERIFIED`, `HASH_MISMATCH`).
- Nothing answers on `http://127.0.0.1:<port>/api/health` within one second. Only a refused connection counts as stopped; a timeout is treated as running (`API_RUNNING`). `--port` defaults to `BACKEND_PORT`, then 3001.
- An exclusive, non-waiting lock on the active database succeeds. This fails while any other process has the database open, including an idle API connection or a stray script (`DATABASE_IN_USE`). If no active database exists yet, this probe is skipped and the command says so.

Steps, each timed:

1. `checkpoint`: while holding the exclusive lock, fold committed WAL frames into the main file, then close.
2. `move`: rename the active file and any `-wal`, `-shm` or `-journal` sidecar to `<name>.pre-restore-<UTC time>`. Nothing is deleted, and a stale WAL can never be replayed onto the restored file.
3. `install`: copy the verified file to `<active>.restoring`, fsync it, rename it to the active path.
4. `postCheck`: `PRAGMA quick_check`, schema version and sha256 of the installed file must match the report.

If any step fails, the installed file is removed, the `.pre-restore-*` files are renamed back and the command fails with `PROMOTE_FAILED_ROLLED_BACK`. If even that rollback cannot complete, it fails with `PROMOTE_ROLLBACK_INCOMPLETE` and lists the files to move back by hand. Other codes: `ACTIVE_DIR_NOT_FOUND`, `RESTORE_IN_PROGRESS` (a `.restoring` file was left by an earlier attempt), and `ACTIVE_NOT_SQLITE`. That last one means the active file is so damaged that SQLite cannot open it, so the lock probe cannot run. With the API stopped, move that file and any `-wal`/`-shm` next to it aside by hand, then run the promote again; it will install onto the now-empty path.

Keep the API stopped until the promote command has finished. The probes run before any file is touched, and the install step refuses to continue if a new database file appears at the active path. They cannot stop a process from being started in the middle of the cutover, and a process started then would interfere with the automatic rollback.

Then start the API again and check `GET /api/health`.

## Protected storage

Backups contain wallet addresses, session token hashes, activity reports, drafts, review decisions and audit events. Treat them like the live database.

- Store them outside the repository, outside any web or static root, and never in Git or a ZIP delivery. `*.sqlite` is git-ignored, but the manifest `.json` files are not, which is another reason to keep the backup directory outside the working tree.
- Restrict access to the operator account. On Linux and macOS the backup file is created with mode 0600 and verification targets with 0700 (subject to umask). Make the backup directory 0700 too (`chmod 700 /secure/revmarket-backups`).
- On Windows these modes are not enforced: NTFS ignores POSIX permission bits, so the files inherit the directory's ACL. Restrict the directory instead, for example in cmd.exe `icacls C:\secure\revmarket-backups /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`, or in PowerShell `icacls C:\secure\revmarket-backups /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"`.
- Use encrypted storage (an encrypted volume or encrypted off-host copies). The commands do not encrypt anything themselves.
- Keep at least one copy on a different disk or host from the live database.

## Retention

Retention is an operator policy; nothing is deleted automatically. A reasonable starting point is 7 daily and 4 weekly backups. When a backup expires, delete the `.sqlite` file and its `.manifest.json` together. Delete `.pre-restore-*` files and old verification targets once the restored database has been confirmed in use. Remember that a backup keeps data, including profiles a user has deleted, until the backup itself is deleted. Set the retention period with that in mind.

## Cutover downtime

Backup and verification need no downtime. Promotion needs the API stopped from the moment you stop it until the restarted API answers its health check.

Measured with `npm run db:drill -- --drafts 5000` (fixture measurements: synthetic data in a temporary directory, the real `backend/server.mjs` as a local child process; Windows 11 Home 10.0.26200, AMD Ryzen 5 5600H, Node v24.13.0; database 4.4 MB, 5,058 drafts and 10,114 revisions):

| Step | ms |
|---|---|
| Backup while the API ran and a separate writer process committed (55 commits during the backup) | 215 |
| Restore verification | 79 |
| Promote: checkpoint / move / install / postCheck | 10 / 2 / 43 / 33 |
| Promote total | 90 |
| Stop API | 10 |
| Restart API to healthy | 1,220 |
| Recovery (verify + promote + restart) | 1,388 |
| Cutover downtime (stop + promote + restart) | 1,320 |

Timings vary between runs on the same machine (an earlier run measured 87 ms for the backup and 1,061 ms of downtime); treat them as an order of magnitude. Most of the downtime is Node and backend start-up, not the file operations.

A manual run with the npm commands against a running `npm run backend` on a scratch 2.3 MB database (live local process, same machine) took about 2.8 s of downtime: 0.26 s to stop, 0.77 s for the promote command including Node start-up, and 1.8 s for `npm run backend` to answer its health check. Expect larger databases to scale roughly with file size for backup, verification and install. Run the drill on your own hardware with your expected size before relying on these numbers.

## Rollback

After a successful promote, the previous database is still on disk as `<active>.pre-restore-<UTC time>` (plus any sidecars). To go back:

1. Stop the API.
2. Move the restored database and any `-wal` or `-shm` next to it aside (do not delete them until you are sure).
3. Rename each `.pre-restore-<UTC time>` file back to its original name.
4. Start the API and check `GET /api/health`.

The promote command prints these steps with the exact paths. Writes made to the restored database after the cutover are not in the old database; export what you need first.

The original database is preserved with all of its committed data. If it was closed cleanly, the `.pre-restore` file is byte-for-byte identical to the original. If the API had crashed and left a non-empty `-wal`, the checkpoint step first folds those committed frames into the main file, so the bytes differ but no committed row is lost.

## What verification proves and what it does not

It proves that the restored copy is the exact file the backup command produced (hash), that SQLite finds no structural corruption, that the schema version is one this backend can open, that foreign keys hold, and that drafts, revisions and review decisions reference each other consistently. It also proves that every table has the row count recorded at backup time.

It does not prove that the data is correct in a business sense, that the backup is recent enough, or that the backup was taken from the right database. It cannot detect a backup that was replaced together with a matching manifest, because the manifest is not signed. Protect the backup directory accordingly. Activity records remain unverified client reports and are not a ledger.

## Schema versions

The supported range is not hard-coded. It is 2 up to whatever version `backend/store.mjs` migrates to (`openStore(':memory:')`). If a newer backend (for example a future v3) restores a v2 backup, verification accepts it and the backend migrates the file on its next start; keep the `.pre-restore` files until that start has succeeded. An older backend refuses a backup with a newer schema (`SCHEMA_UNSUPPORTED`), the same way it refuses a newer live database.

## Drill

```sh
npm run db:drill -- --drafts 5000
```

The drill runs entirely in a new temporary directory and never touches `backend/data`. It seeds a populated v2 database with synthetic data, starts the real backend on it and a separate writer process, takes a backup during the writes, verifies it and checks that a flipped byte and a corrupted page are rejected. It also confirms that promote is refused while the API runs and while the database is held open, then stops the API, promotes, restarts it, compares row counts with the manifest and prints the timings as JSON labelled `"source": "fixture"`. Use `--keep` to keep the temporary directory for inspection.
