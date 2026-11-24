# Canonical market rules digest (`revmarket.rules.v1`)

This document specifies the deterministic byte format and SHA-256 digest calculation implemented in `shared/rules-digest.mjs` for reviewed market rules (`revmarket.rules.v1`).

## Purpose and isolation from historical draft hashes

- Draft revisions in `backend/app.mjs` continue to compute `draft_revisions.content_hash` using the legacy revision hash so existing stored revisions are never silently reinterpreted.
- Reviewed market rules destined for publication use the versioned `revmarket.rules.v1` payload serialized with UTF-8 [RFC 8785 (JSON Canonicalization Scheme)](https://www.rfc-editor.org/rfc/rfc8785) and hashed with SHA-256 to produce a 64-character lowercase hexadecimal digest.
- Publication intents (`publication_intents`) store `rules_digest_version` (`"revmarket.rules.v1"` for canonical intents, `"legacy.revision_content_hash"` for previously persisted pre-v5 rows) and `rules_json` (the exact canonical RFC 8785 JSON committed by the intent, or `NULL` for legacy rows) separately from `draft_revisions.content_hash` (exposed as `revisionContentHash`).
- Incomplete approved revisions cannot issue a canonical publication intent (`409 Conflict` with `code: "incomplete_canonical_rules"` and `requiresFreshApproval: true`) until edited and freshly approved. Previously persisted legacy intents remain readable with their original `rulesDigest`, `rulesDigestVersion: "legacy.revision_content_hash"`, `canonicalRules: null`, and `requiresFreshApproval: true`, and are never silently relabeled as canonical.
- Display-only metadata (`metadata`), local database identifiers (`id`, `draftId`, `revisionId`, `revisionNumber`), reviewer notes (`reviewNotes`, `reason`), and off-chain session/approval fields (`signature`, `origin`, `status`, `contentHash`) are excluded from the canonical rules object.

## Canonical schema fields

Every `revmarket.rules.v1` object contains the following 18 top-level properties (serialized in lexicographical UTF-16 code unit key order per RFC 8785):

| Key | Type | Validation rule |
|---|---|---|
| `category` | `string` | Non-empty well-formed UTF-8 string (`1..=128` chars) |
| `collateral` | `string` | `"native"` or a valid Stellar contract address (`C...`) |
| `equalityRule` | `string \| null` | Non-empty string (`1..=2048` chars) or explicit `null` |
| `fallbackRule` | `string \| null` | Non-empty string (`1..=2048` chars) or explicit `null` |
| `feeBps` | `integer` | Safe integer in `0..=1000` |
| `implementationVersion` | `string` | Non-empty string (`1..=128` chars) |
| `network` | `string` | Non-empty string (`1..=128` chars), e.g. `"testnet"` |
| `noRule` | `string` | Non-empty string (`1..=2048` chars) |
| `observationTime` | `integer \| null` | Safe integer UTC Unix seconds (`>= tradingClose`) or explicit `null` |
| `policyVersion` | `string` | Non-empty string (`1..=128` chars) |
| `question` | `string` | Non-empty string (`1..=512` chars) |
| `resolutionDeadline` | `integer` | Safe integer UTC Unix seconds (`> tradingClose` and `>= observationTime` when present) |
| `resolver` | `string` | Valid Stellar public key (`G...`) or contract address (`C...`) |
| `schema` | `string` | Fixed literal `"revmarket.rules.v1"` |
| `sources` | `array` | Ordered array of `1..=10` HTTPS URL strings or canonicalized source objects with an `https://` `url` |
| `tradingClose` | `integer` | Positive safe integer UTC Unix seconds |
| `unavailableDataRule` | `string` | Non-empty string (`1..=2048` chars) |
| `yesRule` | `string` | Non-empty string (`1..=2048` chars) |

## Reproducible test vectors for Rust and JS consumers

### Vector 1: Price threshold market with ordered HTTPS source URLs

Canonical UTF-8 JSON bytes (`947` bytes):

```json
{"category":"crypto","collateral":"native","equalityRule":"Exact equality at 100000.00 USD resolves to NO.","fallbackRule":"If one source is unavailable, resolve when two remaining sources agree within 2 percent.","feeBps":30,"implementationVersion":"v2.0.0-rc1","network":"testnet","noRule":"Spot median across listed sources is less than or equal to 100000.00 USD.","observationTime":1800000060,"policyVersion":"v1.0.0","question":"Will BTC/USD exceed 100,000 USD at the observation time?","resolutionDeadline":1800086400,"resolver":"GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H","schema":"revmarket.rules.v1","sources":["https://api.coinbase.com/v2/prices/BTC-USD/spot","https://api.kraken.com/0/public/Ticker?pair=XBTUSD","https://www.bitstamp.net/api/v2/ticker/btcusd/"],"tradingClose":1800000000,"unavailableDataRule":"If fewer than two sources report within the window, market resolves Invalid.","yesRule":"Spot median across listed sources is strictly greater than 100000.00 USD."}
```

SHA-256 hex digest:

```text
64e154c9898827651153a989e28a5674e8c92c179221b55264784d491c6306e9
```
