# Contract API: current v1 and proposed v2

> Documentation review: 31 October 2026. Source: `RevMarket22.zip`. **As-is** means present in inspected source, not independently proven in production. **Proposed v2** means design only; no v2 contracts or deployment are delivered.


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

## Exact current signatures

The implicit first argument is `Env`; it is supplied by Soroban, not encoded by clients. All methods except the listed returning methods return unit. The private Rust helpers `settle` and `settle_inner` are not exported contract methods.

```rust
__constructor(token: Address, resolver: Address)
create(creator: Address, question: String, description_cid: String,
       image_cid: String, kind: Kind, closes_at: u64) -> u32
predict(user: Address, id: u32, side: u32, amount: i128)
request(id: u32)
settle_event(id: u32, outcome: u32, confidence: u32, evidence: BytesN<32>)
settle_price(id: u32, price: i128, evidence: BytesN<32>)
claim(user: Address, id: u32) -> i128
get_market(id: u32) -> Market
get_position(id: u32, user: Address) -> Option<Position>
count() -> u32
keepalive(id: u32, user: Address)
```

`create` returns IDs starting at zero; `count` is the next ID, not the last ID. There is no pagination or market-list method. `get_position` reads the keyed position directly; an unknown market with no matching position returns None rather than necessarily producing Missing.

### Current returned structures

```rust
enum Kind { Event, Price(Symbol, i128) }
struct Market {
    creator: Address,
    question: String,
    description_cid: String,
    image_cid: String,
    kind: Kind,
    closes_at: u64,
    deadline: u64,
    status: u32,
    yes_pool: i128,
    no_pool: i128,
    outcome: u32,
    confidence: u32,
    evidence: BytesN<32>,
}
struct Position { amount: i128, side: u32, claimed: bool }
```

`outcome=0`, `confidence=0` and zero evidence are creation defaults, not an early YES resolution. Interpret outcome only after terminal settlement. Refundable status can retain a resolved outcome when no winning stake existed. Amounts use exact signed 128-bit integers but accepted stakes and price values must be positive. String limits are SDK byte lengths; frontend character counts are not a substitute for simulation.

### Current event payloads

| Topics | Data |
|---|---|
| `('created', id)` | `closes_at` |
| `('predict', id)` | `(user, side, amount)` |
| `('request', id)` | `closes_at` |
| `('settled', id)` | `(outcome, confidence)` |
| `('claimed', id)` | `(user, payout)` |

No dedicated timeout-refund event is emitted when claim changes status; observe claim and reconcile state. The settled event omits the evidence digest, which must be read from market state. No event proves factual evidence correctness.

### Current client example

From a source checkout with dependencies installed:

```js
import {createClient, sc} from './shared/stellar.mjs';
const client = createClient({rpcUrl, contractId});
const m = await client.read(publicFundedAccount, 'get_market', [sc.u32(0)]);
// sign must return Freighter-signed XDR for the expected account and Testnet.
await client.write(user, sign, 'predict', [
  sc.address(user), sc.u32(0), sc.u32(0), sc.i128(10_000_000n)
]); // one test XLM on YES
```

Do not JSON-serialize BigInt directly; use decimal strings at HTTP boundaries. Check final confirmation hashes before retrying. `keepalive` only persists TTL extensions as a submitted transaction; a simulation is insufficient. Automatic restoration is absent.

## Proposed v2 API — design contract, not implemented ABI

Names/types below define an implementation target, not callable methods at the current contract address. Generate final bindings from compiled specs after review. Use enums instead of assuming old side/status numeric values. Child methods identify the market by contract address and have no legacy market ID parameter.

```rust
enum Side { Yes, No }
enum FinalOutcome { Yes, No, Invalid }
struct MarketParams {
    rules_hash: BytesN<32>, metadata_cid: String,
    collateral: Address, closes_at: u64, resolution_deadline: u64,
    resolver: Address, resolution_policy_hash: BytesN<32>, fee_bps: u32,
}
struct MarketRecord {
    address: Address, creator: Address, reviewer: Address, version: u32,
    wasm_hash: BytesN<32>, params_hash: BytesN<32>,
}
// Proposed factory
__constructor(operator: Address)
approve_version(version: u32, wasm_hash: BytesN<32>) // operator auth; future creates only
set_creation_paused(paused: bool)                   // operator auth
set_reviewer(reviewer: Address, enabled: bool)       // operator auth; advances role epoch
get_reviewer(reviewer: Address) -> ReviewerRole
create_market(creator: Address, reviewer: Address, version: u32,
              nonce: BytesN<32>, approval_expires_at: u64, reviewer_epoch: u32,
              params: MarketParams) -> Address      // creator + reviewer auth; atomic deploy/register
invalidate_creation_nonce(creator: Address, nonce: BytesN<32>) // creator auth; terminal invalidation
get_market(address: Address) -> Option<MarketRecord>
list_markets(start: u32, limit: u32) -> Vec<MarketRecord> // bounded limit

// Proposed per-market child
__constructor(factory: Address, creator: Address, version: u32, params: MarketParams)
split(user: Address, collateral_in: i128)            // user auth; mint complete sets
merge(user: Address, pairs: i128) -> i128             // user auth; burn pairs, return backing
transfer_shares(from: Address, to: Address, side: Side, shares: i128) // from auth
quote_buy(side: Side, collateral_in: i128) -> Quote
buy(user: Address, side: Side, collateral_in: i128,
    min_shares_out: i128, deadline: u64) -> i128      // user auth
quote_sell(side: Side, shares_in: i128) -> Quote
sell(user: Address, side: Side, shares_in: i128,
     min_collateral_out: i128, deadline: u64) -> i128 // user auth
add_liquidity(user: Address, max_yes: i128, max_no: i128,
              min_lp_out: i128, deadline: u64) -> LiquidityReceipt // user auth
remove_liquidity(user: Address, lp_in: i128, min_yes: i128,
                 min_no: i128, min_fees: i128, deadline: u64) -> LiquidityReceipt
request_resolution()                                // permissionless at/after close
resolve(outcome: FinalOutcome, evidence: BytesN<32>) // resolver auth; trusted-policy only
finalize_timeout()                                  // permissionless after deadline
redeem(user: Address, side: Side, shares: i128) -> i128 // user auth; finalized only
get_state() -> MarketState
get_balances(user: Address) -> Balances
keepalive(user: Address)                             // submitted storage maintenance
```

Proposed `Quote`: input amount, output amount, fee, pretrade reserves, state version and market status. Use exact i128 for monetary fields; display price impact off-chain from exact integers. `LiquidityReceipt` includes consumed/returned YES/NO, LP units and collateral fees. `MarketState` includes immutable params/version, lifecycle, reserve balances, total outcome supplies, backing, fee reserve, LP supply, final outcome and evidence. `Balances` includes YES, NO and LP units. Full ScVal encodings and error numbers await implementation; do not reuse current error numbers as a v2 ABI promise.

Every state-changing financial method must check nonnegative/positive amounts as appropriate, phase, balance, arithmetic bounds, expiry and output minima before any successful commit. `split`, `merge`, transfers, trades and LP changes initially stop at close; allow redemption and terminal LP inventory exit after finalization. Document any phase exception before release. Factory operator cannot call user transfers, resolve a child or withdraw collateral through factory authority. Reviewer approval cannot substitute for the creator’s spending or deployment authorization.

Require factory-authenticated child initialization and atomic version/params validation so arbitrary deployment cannot impersonate an approved registry entry. Factory version policy must be immutable for already-created children. `approve_version` cannot overwrite an existing version hash.

Proposed events: MarketCreated(version,address,creator,reviewer,params_hash,wasm_hash), Split, Merge, SharesTransferred, Trade(side,direction,input,output,fee,reserves), LiquidityAdded/Removed, ResolutionRequested, ResolutionFinalized(outcome,evidence,policy_hash), Redeemed, CreationPaused, CreationNonceInvalidated(creator,nonce) and ReviewerRoleChanged(address,enabled,epoch). Emit user/address, integer amounts, and versioned schemas sufficient for reconciliation. A later dispute adapter needs additional methods/events; it is outside this trusted-policy interface.

No API above grants automated claims. A01's claim-only opt-in/expiry/revocation work is a separate proposal and must not be confused with v2 trading consent or backend sign-in. Keep legacy claims user-authorized until a separately reviewed on-chain permission exists.

## Proposed authoring and review interfaces — backend, not current APIs

`ReviewerRole` contains enabled and a monotonically advanced epoch. `create_market` must require both creator and reviewer authorization over the full invocation, reject self-review, inactive/mismatched epoch, expired approval and replayed creator nonce. Transaction/auth expiration must also be valid. A modified field requires fresh review and authorizations. Draft IDs are off-chain references, not substitutes for canonical rules hashes.

The current `create` method has no reviewer check. The following routes are design targets and must be added with explicit schema migrations, ownership checks and reviewer-role verification; none is delivered in the inspected backend:

| Method and path | Target behavior and authority |
|---|---|
| POST `/api/drafts` | Signed creator session; create an owned manual draft |
| GET `/api/drafts` | Own drafts only; bounded pagination |
| GET/PATCH `/api/drafts/:id` | Owner; reviewer read only when submitted; updates require expected revision |
| POST `/api/drafts/:id/ai-suggestions` | Owner; bounded AI request with revision; returns suggestions without changing the draft |
| POST `/api/drafts/:id/submit` | Owner; exact revision; deterministic validation and public-disclosure consent |
| POST `/api/drafts/:id/withdraw` | Owner; predeployment only; invalidate pending publication intent |
| GET `/api/reviews` | Authorized reviewer; paginated submitted revisions |
| POST `/api/drafts/:id/reviews` | Authorized non-owner reviewer; exact revision, decision and reason |
| POST `/api/drafts/:id/publication-intents` | Owner; Approved revision only; returns exact invocation/unsigned authorization payloads and expiry |
| GET `/api/publication-intents/:id` | Owner/reviewer; pending, expired, failed or confirmed with public chain references |

Off-chain withdrawal prevents service publication but cannot revoke already-issued independent chain authorization by itself. For a fully revocable per-intent approval before execution, add an on-chain nonce invalidation method requiring creator auth, `invalidate_creation_nonce(creator, nonce)`. Factory nonce state must distinguish unused, consumed and invalidated; both consumed and invalidated reject creation. Include this method in the implemented factory ABI and test its race with deployment. A completed deployment wins a prior execution race and cannot be undone by withdrawal.

Backend login proves session identity only. Review decisions do not contain private keys. Transaction authorization is collected separately from backend sign-in. Administrative backend routes need explicit access controls, audit logs and chain-role reconciliation; the existing network-status allowlist does not implement factory reviewer management.

Draft requests use exact integer strings for chain amounts and schema-validated timestamps. Return revision-conflict errors for stale writes and idempotent results for repeated publication requests. Log state transitions and chain hashes without cookies, signing material, provider secrets or private prompt contents. AI responses include schema version, originating revision, suggested fields, source candidates, ambiguity warnings and duplicate candidates; they cannot contain executable commands or deployment approval.
