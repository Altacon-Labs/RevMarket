# Exporting settlement evidence

The resolution worker writes each settlement's evidence to `service/evidence/<sha256>.json` and records that SHA-256 digest on chain as `Market.evidence`. The digest commits to the exact bytes of the file (`sha256(JSON.stringify(evidence))`), so a copy only verifies if it is byte-for-byte identical to what the worker wrote.

`npm run evidence:export` copies the stored file for one digest into a directory you choose. It checks the bytes first and never rewrites them.

## Scope

- The command is read-only toward the evidence root. It reads one file and writes one file to the output directory.
- It does not publish, upload or host anything. Operators decide which evidence is approved for sharing and how it reaches the recipient.
- It only exports files in the worker's v1 evidence format (`service/runner.mjs`).

## Usage

```sh
npm run evidence:export -- <digest> --out <dir> [--root <dir>]
# or
node scripts/export-evidence.mjs <digest> --out <dir> [--root <dir>]
```

- `<digest>` is the 64-character lowercase hex value recorded on chain. Uppercase, shortened or path-like values are rejected.
- `--out` must be an existing directory outside the evidence root. It is never created, and an existing `<digest>.json` in it is never overwritten.
- The evidence root comes from `--root`, then the `EVIDENCE_DIR` environment variable, then `service/evidence/`.

On success the command writes `<out>/<digest>.json` and prints one JSON line to stdout. When parsing that line from a script, use `node scripts/export-evidence.mjs` or `npm run -s evidence:export`, because plain `npm run` also prints its own banner to stdout.

```json
{"digest":"7a52df7e...","bytes":713,"outFile":"/srv/share/7a52df7e....json","contractId":"CCRZ...","marketId":0}
```

On failure it exits with status 1, prints `evidence:export failed [CODE]: <message>` to stderr and leaves no exported file in the output directory (see Limitations for temporary files). File contents are never printed.

The same logic is available to Node code as `exportEvidence({root, digest, out})` from `service/evidence-export.mjs`. It throws `EvidenceExportError` with the `code` listed below.

## What is checked

1. The digest matches `^[0-9a-f]{64}$`. This is checked before any file is touched.
2. The evidence root is resolved with `realpath`. The root itself may be a symlink or junction.
3. `<root>/<digest>.json` must be a regular file that resolves inside the root. Symlinks and junctions in its place are rejected.
4. The file must be between 1 byte and 1 MiB, the same limit the in-browser verifier uses.
5. The bytes are read from a single file handle and hashed with SHA-256. They must equal the requested digest.
6. The bytes are parsed only to validate the v1 shape. Top-level keys must be exactly `version`, `contractId`, `marketId`, `question`, `closesAt`, `observations` and `decision`, so no unrelated top-level fields are exported. The parsed value is never re-serialized.
7. The bytes are written to a temporary file in the output directory, flushed and hard-linked to `<digest>.json`. The link fails if the name already exists. The result is re-read and re-hashed, and any temporary or partial file is removed on failure.

## Error codes

| Code | Meaning |
|---|---|
| `INVALID_DIGEST` | the digest is not 64 lowercase hex characters |
| `INVALID_ARGUMENT` | library only: an empty root or output path, or a non-positive `maxBytes` |
| `USAGE` | command-line arguments are missing, repeated or unknown |
| `ROOT_NOT_FOUND` / `ROOT_NOT_DIRECTORY` | the evidence root does not exist or is not a directory |
| `EVIDENCE_NOT_FOUND` | there is no `<digest>.json` in the evidence root |
| `SYMLINK_REJECTED` | the evidence path is a symlink or junction |
| `NOT_A_FILE` | the evidence path is not a regular file |
| `OUTSIDE_ROOT` | the evidence path resolves outside the evidence root |
| `CHANGED_DURING_READ` | the file was replaced between the checks and the read |
| `EMPTY` / `TOO_LARGE` | the file is empty or larger than 1 MiB |
| `DIGEST_MISMATCH` | the stored bytes do not hash to the digest; both hashes are shown |
| `MALFORMED_JSON` | the file is not valid UTF-8 JSON |
| `NOT_V1_EVIDENCE` | the JSON is not v1 evidence; the message names the failing field |
| `OUT_NOT_FOUND` / `OUT_NOT_DIRECTORY` | the output directory does not exist or is not a directory |
| `OUT_INSIDE_ROOT` | the output directory is the evidence root or inside it |
| `OUTPUT_EXISTS` | `<out>/<digest>.json` already exists |
| `LINK_FAILED` | the output file could not be created, for example on a filesystem without hard links |
| `WRITE_VERIFY_FAILED` | the written copy did not hash to the digest and was removed |
| `IO_<errno>` | an unexpected filesystem error, such as `IO_EACCES` |

## Verifying a received file

The recipient compares the file's SHA-256 with the market's on-chain evidence digest:

```sh
sha256sum <digest>.json                          # Linux
shasum -a 256 <digest>.json                      # macOS
certutil -hashfile <digest>.json SHA256          # Windows
Get-FileHash <digest>.json -Algorithm SHA256     # Windows PowerShell (prints uppercase hex)
```

Do not open and re-save the file in an editor first. Any change to whitespace, key order or line endings changes the hash. Once the in-browser verifier (issue #14) is available, it performs the same comparison and also checks that the file's contract ID, market ID, question and close time match the selected market.

Digest match verifies these bytes against the recorded commitment; it does not verify the outcome or source truthfulness.

## Limitations

- Evidence remains operator-held. If the worker's file is lost, it cannot be recovered from chain; only the digest is on chain.
- Hard links inside the evidence root are treated as regular files. Keep the root writable only by the worker account.
- Hard links require the output directory to be on a filesystem that supports them (NTFS, ext4, APFS and similar). FAT/exFAT drives and some network shares fail with `LINK_FAILED`; export to a local disk first and copy the file from there.
- Only top-level keys and v1 field types are validated. The content of each observation is exported as recorded, since it is part of the committed bytes.
- If the process is killed mid-export, or the operating system blocks deleting the temporary file (for example an antivirus or sync client holding it open), a hidden `.<digest>.<pid>.<uuid>.tmp` file can remain in the output directory. It is safe to delete.
