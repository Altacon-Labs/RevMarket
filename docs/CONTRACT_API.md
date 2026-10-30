# Soroban API and invariants

The hand-written client encoder is `shared/stellar.mjs`. Integers are never converted to JavaScript `Number` for escrow or price arithmetic. IDs/status/outcome/confidence are `u32`; timestamps are `u64`; amounts and prices are `i128`.

| Method | Arguments | Authorization / behavior |
|---|---|---|
| Constructor | token Address, resolver Address | Immutable configuration; token must report 7 decimals |
| `create` | creator, question String, description_cid String, image_cid String, kind Kind, closes_at u64 | Creator signs; returns sequential u32 ID. Event markets require an image CID, limited to 128 characters |
| `predict` | user Address, id u32, side u32, amount i128 | User signs; one position; transfers token into escrow |
| `request` | id u32 | Permissionless, after close and before/equal deadline; once |
| `settle_event` | id, outcome u32, confidence u32, evidence BytesN<32> | Immutable resolver signs; only Event kind |
| `settle_price` | id, price i128, evidence BytesN<32> | Immutable resolver signs; contract applies strict `price > target` |
| `claim` | user Address, id | User signs; transfers winnings/refund to that address; returns i128 payout |
| `get_market` | id | Returns Market; rejects unknown ID |
| `get_position` | id, user Address | Returns optional Position |
| `count` | none | Returns next market ID |
| `keepalive` | id, user Address | Permissionless submitted TTL maintenance; no token movement |

`Kind` is a Soroban enum: `Event` or `Price(asset Symbol, target i128)`. On the wire these are vectors `['Event']` and `['Price','ETH',target]`. Asset symbols: BTC, ETH, XLM. Target/observations use `10^-8 USD`. Native XLM SAC amounts use `10^-7 XLM`.

State transitions: Open (0) → Requested (1) → Settled (2) or Refundable (3). Open/Requested become Refundable lazily when a claimant calls after the deadline. Thus `get_market` can still return Open/Requested after timeout; clients derive refund eligibility from the timestamp. A settled market never changes its outcome. There is no cancellation or arbitrator override.

YES = 0, NO = 1. New predictions require `now < close`; requests/settlements allow `close <= now <= deadline`; timeout refunds require `now > deadline`. Confidence must be 8000–10000 and evidence digest nonzero. Settlement requires Requested status, so neither operator nor user can resolve an unrequested market.

Deposits are capped at a combined `10^18` base units per market. Payout numerator is bounded by `10^36`, below signed 128-bit maximum. Each winner can claim once. Total integer payouts are at most deposits; rounding dust remains. With no winning stake the whole market refunds, avoiding an irrecoverable losing-only pool. Different markets have independent accounting even though they share the token balance.

Error codes: Missing=1, Invalid=2, Closed=3, Duplicate=4, NotReady=5, Nothing=6, Overflow=7. Host authorization/token/storage failures may produce host errors rather than those contract codes. All failures are atomic, including token transfer failures.

Events: `created`, `predict`, `request`, `settled`, `claimed`, with market ID as a topic. The current worker uses on-chain state polling rather than event indexing; events are retained for future indexing. The SDK's legacy event publishing API currently emits deprecation warnings, without build failures.
