# Reviewed Factory Receipt Reconciliation — Design

Scope document for [W48 #85](https://github.com/Altacon-Labs/RevMarket/issues/85). This PR lands the design only; implementation is deferred until the reviewed factory ABI (#84) and the related work in #76 and #82 are merged. That is the ordering the issue itself calls for.

## Goal

Give the website a verified link from an **approved revision** to a **deployed market** (contract address + transaction hash), so a creator who signs the submission sees their new market appear in the market list and nowhere else — and so late confirmations, replays and refreshes all converge on the same single mapping.

## Why the current path is unsafe

- [`backend/app.mjs:63`](../backend/app.mjs#L63) — the intent response body has no contract address and no transaction hash. The creator UI has nothing it can trust to show.
- [`backend/indexer.mjs:1`](../backend/indexer.mjs#L1) — the indexer follows a single hardcoded legacy contract id. A v2 market deployed by the reviewed factory is invisible to it.
- [`backend/store.mjs:146`](../backend/store.mjs#L146) — intents are stored by revision id with no chain-identity slot. There is no place to persist `{ factory, network, contract_address, tx_hash, ledger }` even after it is known.
- [`frontend/src/lib/backend.mjs:674`](../frontend/src/lib/backend.mjs#L674) — the creator flow optimistically marks the revision as deployed. Nothing on the client proves the on-chain evidence matches the approved terms.

## Data model

Add a `deployment` block to the stored intent. The block is **append-only after promotion** — a verified deployment never gets rewritten by a later re-submission.

```jsonc
{
  "revision_id": "rev_…",            // existing
  "approval": { … },                 // existing
  "deployment": {
    "state": "awaiting_signing"      // see state machine below
            | "awaiting_confirmation"
            | "deployed"
            | "cancelled"
            | "stale_approval"
            | "unknown_receipt",
    "factory":          "C…",        // factory contract id used by the signer
    "network":          "testnet",   // "testnet" | "futurenet" | "mainnet"
    "creator":          "G…",
    "approved_hash":    "sha256:…",  // sha256 of the normalised approved terms
    "intent_tx_hash":   "…",         // submitted by the signer
    "confirmed_tx_hash":"…",         // observed by the indexer
    "contract_address": "C…",        // the deployed market
    "ledger":           12345678,    // ledger of the confirmed event
    "updated_at":       "ISO-8601"
  }
}
```

`approved_hash` is the hash of the canonical review-approved terms. The indexer only promotes an intent to `deployed` when the event's embedded approved-terms hash matches `approved_hash`. Replays and stale approvals cannot forge a listing.

Add one indexed table (DB or JSON file, matching current backend style):

| Table | Primary key | Purpose |
|---|---|---|
| `markets_by_address` | `contract_address` | O(1) lookup from a routing request to the owning revision |

## State machine

```
         ┌──────────────┐       sign       ┌──────────────────────┐
  start ─▶ awaiting_signing ────────────▶ │ awaiting_confirmation│
         └──────────────┘                 └──────────┬───────────┘
                │                                    │ matching event
                │ creator cancels                    ▼
                ▼                              ┌───────────┐
          cancelled                             │ deployed  │ ◀── terminal
                                               └───────────┘
                                                    ▲
         non-matching event / unknown factory ──────┤
                                                    │
         approval already consumed ──▶ stale_approval
         event with no local intent  ──▶ unknown_receipt
```

Terminal transitions:
- `deployed` is terminal and is persisted to `markets_by_address`.
- `cancelled`, `stale_approval`, `unknown_receipt` are terminal for the deployment attempt but the creator can start a new signing round with a fresh intent.

## Verification rules (must-match)

An indexer event promotes an intent to `deployed` only when **all** of these hold:

1. The event originates from the factory address recorded in the intent.
2. The event's network matches the intent's network.
3. The event's `creator` topic matches the intent's `creator`.
4. The event carries an `approved_hash` payload field equal to the intent's `approved_hash`.
5. The event's `revision_id` is not already bound to a different `contract_address`.

Any mismatch records `unknown_receipt` on the event side, not on the intent. The intent stays `awaiting_confirmation` until it times out (14 days) or a matching event arrives.

## Idempotency and replays

- A confirmed event for an already-`deployed` intent is a no-op. The second occurrence must leave the `deployment` block byte-for-byte unchanged.
- A refresh at any point returns the current `deployment` block. The frontend derives UI state from `state`; it never computes it client-side.
- The indexer records the last processed ledger per factory; a restart replays from there, not from genesis.

## Routing

`frontend/src/lib/backend.mjs` is the only module that resolves a user action (buy / sell / resolve) to a contract address. After this work:

- Before routing, it looks up `contract_address` via `markets_by_address`.
- If the address is the legacy contract id, it routes through the legacy path (preserves behaviour).
- If the address is new (v2), it routes through the v2 path. **A v2 address never routes to the legacy contract**, even transiently.

## New market = awaiting liquidity

A new market lands in `deployed` with no liquidity by construction. Per the PRODUCT_SPEC, trading is disabled until a liquidity provider seeds the pool. The listing card shows an *Awaiting liquidity* badge and all buy/sell actions are disabled with an explanatory tooltip. This state reads directly from a v2-only pool-balance query, not from an application flag — the badge cannot lie.

## Capability gate

The creator UI shows the Sign & Deploy control only when `capabilities.reviewed_factory_enabled === true` **and** the revision is approved by at least the configured reviewer quorum. The capability flag comes from `/config` so it can be toggled per environment without a redeploy.

## Error recovery surfaces

| State | Creator-visible action |
|---|---|
| `awaiting_signing` | Sign; Cancel |
| `awaiting_confirmation` | Copy intent tx hash; Resend (same intent, no re-approval) |
| `stale_approval` | Start a new review round |
| `unknown_receipt` (on event side) | Operator-only recovery view; not surfaced to the creator |
| `cancelled` | Start a new submission |

## Regression tests (land with the implementation PR)

- Capability flag off → the Sign control is not rendered.
- Cancel at `awaiting_signing` → state is `cancelled`; a subsequent matching event becomes `unknown_receipt`, not `deployed`.
- Approved-hash mismatch on event → intent stays `awaiting_confirmation`; event file logs `unknown_receipt`.
- Two matching events arriving within one second → one `deployment` block, one listing, idempotent.
- Late confirmation (event arrives 10 min after submission) → still promotes to `deployed` provided the 14-day window has not lapsed.
- Legacy contract address → routes to legacy path; v2 address → never routes to legacy.

## Order of implementation (follow-up PRs)

1. **Store schema bump** — add `deployment` to intents, add `markets_by_address` table, migration keeps legacy intents readable.
2. **Signer response** — `backend/app.mjs:63` returns the pending `deployment.state`; the frontend `backend.mjs:674` surfaces it.
3. **Indexer promotion** — `backend/indexer.mjs` follows the factory address, applies the verification rules, writes terminal states.
4. **Routing** — `frontend/src/lib/backend.mjs` reads from `markets_by_address` before dispatching.
5. **Listings + Awaiting liquidity badge**.
6. **Capability gate** in `/config` and the creator UI.

Each step is small enough to land behind a feature flag so the legacy flow stays shippable.
