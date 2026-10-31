# Product specification

> Documentation review: 31 October 2026. Source: `RevMarket22.zip`. **As-is** means present in inspected source, not independently proven in production. **Proposed v2** means design only; no v2 contracts or deployment are delivered.


## 1. Product direction

Build understandable, reusable open-source prediction-market infrastructure on Stellar. The immediate product remains a Testnet pooled-staking prototype. The target is a binary outcome-share exchange with an AMM, an explicit resolution policy, and isolated market deployment. A familiar prediction-exchange layout does not imply architectural equivalence with Polymarket.

Primary users are Testnet participants, community market creators, human reviewers, platform administrators, liquidity providers in v2, resolver operators and open-source contributors. Mainnet launch, guarantees about returns, an order book, margin, cross-chain assets, AI settlement authority and automated betting are outside the initial migration scope.

## 2. Current implementation contract

Source authority: `contracts/market/src/lib.rs`, `shared/stellar.mjs`, `service/`, `frontend/src/` and `backend/`.

| Capability | As-is behavior |
|---|---|
| Market creation | Authenticated creator; nonempty question up to 512 bytes; metadata strings up to 128 bytes; Event needs a nonempty image field |
| Event markets | Binary question with trusted resolver settlement; chain does not validate the factual resolution criteria |
| Price markets | BTC, ETH or XLM with positive USD target in 10^-8 units; YES only for observed price strictly above target |
| Timing | Close strictly in future and at most 30 days from creation; deadline close + 86,400 seconds |
| Staking | YES=0, NO=1; positive amount; one immutable position per wallet per market; no top-up, sell, transfer or early withdrawal |
| Escrow | Configured 7-decimal token; intended deployment uses native XLM SAC; aggregate market deposits capped at 10^18 base units |
| Settlement | Permissionless request after close; only immutable resolver can finalize Requested markets within the deadline |
| Claim | User authorizes payout to the same user address; winners claim once; losers cannot claim a settled winning-pool market |
| Refund | No stake on winning outcome, or unresolved after deadline; each participant gets their original stake |
| Fees | No contract trading fee, creation fee or protocol revenue distribution; network fees still apply |
| Data | Latest 50 markets loaded, with a client/worker count guard at 1,000; portfolio is limited to loaded markets |

The constructor checks decimals, not whether the token is the native SAC or economically safe. Metadata fields are opaque strings, not verified CIDs. The UI/backend impose extra image validation and authentication, which do not become chain rules.

### Current payout example

Alice stakes 10 XLM YES; Bob stakes 30 XLM YES; Carol stakes 60 XLM NO. Total=100, YES pool=40. If YES wins, Alice receives `floor(10 × 100 / 40)=25 XLM` and Bob 75 XLM, before their network fees. If NO wins, Carol receives 100 XLM. If there are no winning stakes, everyone refunds. Further stakes before close can change projected returns. Amounts are actually calculated in integer base units; residual rounding dust remains in escrow without a sweep method.

### Resolution semantics

States are Open(0), Requested(1), Settled(2), Refundable(3). Open is not synonymous with accepting stakes after close. Timeout eligibility is derived from timestamp; stored status becomes Refundable lazily during a successful claim. At exactly close, staking fails and requesting/settling is allowed. At exactly deadline, settlement is allowed; timeout refund starts strictly after deadline.

Price resolution samples current USD spot shortly after close, not a historical candle closing price. The worker requires three named sources, median price, at most 2% spread, recent observations and processing no later than close+90 seconds. Event resolution needs 2–5 configured distinct HTTPS hosts with unanimous outcome, exact market/question binding and recent observations. These are off-chain policies which a resolver key can bypass. Confidence is an operator-reported score, not a probability guarantee.

## 3. Proposed v2 requirements

Each factory-created market shall have immutable rules, version, collateral, closing time, resolution policy and market identity. A separate contract address shall isolate each market's escrow and state. Repeated trading shall replace the one-position restriction only for new v2 markets. Legacy stakes retain their original payout rules.

For the first v2 implementation, use 7-decimal Testnet XLM collateral and an internal outcome-share ledger with explicit YES/NO balances and transfers. This is a design recommendation, not implemented SEP-41 outcome tokens. Separate standardized token contracts may follow only after interoperability and deployment complexity are reviewed. One share base unit pays one collateral base unit on the winning side. XLM collateral means XLM-denominated redemption, not a guaranteed $1 payout.

### Complete sets and solvency

Lock C collateral units to mint C YES and C NO units. Before finalization, equal quantities of YES and NO can be burned to release C collateral. After finalization, winning shares redeem at 1:1 and losing shares at zero. An Invalid finalization pays each YES and each NO share one half collateral unit, with explicit integer rounding. Thus a complete set totals at most one collateral unit. Splitting/merging must conserve supply and backing; fees and unsolicited transfers must have separate accounting.

An unresolved v2 market should become Invalid after its fixed resolution deadline; it cannot refund original deposits after shares have changed hands. Integer dust must be tracked. There shall be no discretionary sweep of outstanding redemption liabilities. A terminal dust policy needs review before any release beyond Testnet.

### AMM recommendation

Use a binary fixed-product market maker with inventory reserves Y YES and N NO and `k=Y×N`. Start with balanced funding L: lock L collateral, mint L of each outcome and allocate those shares to AMM inventory. Initial marginal YES price is `N/(Y+N)` collateral per share and NO is `Y/(Y+N)`. These marginal values differ from a trade's average execution price. See [Architecture](ARCHITECTURE.md) for exact conservative rounding and sell logic.

All trades shall execute on chain with user authorization, a deadline, minimum output, reserve checks, checked arithmetic and bounded fees. Quotes are estimates tied to a reserve snapshot; they never guarantee execution or liquidity. Closing stops trades and liquidity changes; redemption and claims remain available. Initial design: collateral-denominated trading fees held in a separate LP fee reserve, no protocol fee. Exact `fee_bps`, cap and accounting tests must be fixed in the release manifest before v2 deployment; no current fee is implied.

LPs receive internal liquidity units. In the MVP, additions must be proportional and withdrawals must return a pro-rata basket of YES/NO shares plus earned collateral fees, rather than promising all withdrawals in collateral. Initial units equal L; subsequent additions round minted units down. Define minimum reserves, minimum trade size and maximum totals in implementation tests. Do not deploy with unspecified limits or arbitrary imbalanced seeding.

## 4. Resolution and security target

V2 phase one may retain an explicitly trusted, immutable per-market resolver with published criteria, evidence commitment and timeout. Do not call that decentralized. A later resolver adapter may implement Proposed → Challenge window → Finalized with bonds and a named arbitrator; that phase requires its own specification and tests. No AI response shall finalize a market without the configured authority. Criteria must state source, observation time, threshold equality, ambiguous/invalid cases and unavailable-data behavior before creation.

Factory registration is discoverability, not an endorsement of question quality. UI must separate verified factory entries from arbitrary addresses. New-market pausing may stop factory creation, but must not freeze existing redemption. See [Architecture](ARCHITECTURE.md) for trust and attack surfaces.

## 5. Delivery milestones and acceptance

| Milestone | Deliverable | Exit evidence |
|---|---|---|
| M0: baseline | Reproduce exact archive, correct misleading labels/auth assumptions, verify evidence | Complete JS/Rust checks, build hashes, manual wallet matrix, published source/CI |
| M1: creation and factory foundation | Manual/AI-assisted drafts, review queue, creator confirmation, reviewer-authorized factory deployment | Draft access/revision tests, exact dual authorization, expiry/revocation, WASM deploy and atomic rollback tests |
| M2: exchange core | Complete sets, outcome ledger, AMM, LP units, fees, redemption | Property tests for solvency/conservation, quote/execution equality, independent math review |
| M3: resolution | Published policy, timeout Invalid redemption, evidence tooling | Boundary, unavailable source, dishonest proposal and dispute tests for enabled policy |
| M4: integrated Testnet | Version-aware app, persistent indexer and deployment manifest | Buy/sell/LP/resolve/redeem live exercise, archived-state recovery drill |
| M5: public contribution release | Stable docs, issues, maintenance ownership and Drips application | Public URLs, passing hosted CI, program-specific eligibility confirmed |

M1 can develop alongside M0 but cannot redirect current users to unverified contracts. There is no promised schedule, funding or live deployment. Mainnet requires a separate operational, security and applicable-market legal review; this specification grants no mainnet readiness.

## 6. Success measures

Report reproducible successful end-to-end flows, failed authorization cases, accounting invariant coverage, evidence availability, supported market count and service recovery time. Only measure volume from verified chain events and label Testnet data. Do not use sample liquidity, client-reported activity, or synthetic charts as usage metrics.

## 7. Community, admin and AI-assisted creation — agreed target

The first release uses open submissions with reviewed publication. All users can draft and submit; approval is not guaranteed. Human admins can draft or select AI suggestions, but use the same rules and a separate reviewer. AI is a drafting/research service, not a financial principal. Every deployed market has an identified human creator and reviewer.

| Role | Permitted target actions | Boundary |
|---|---|---|
| Creator | Create/edit own drafts, request AI help, submit, withdraw before deployment, confirm final rules and fund initial liquidity | Cannot approve own submission or resolve by virtue of creation |
| Reviewer | Request changes, reject with reason, approve exact revision, authorize deployment while role is active | Cannot change approved rules silently, spend creator funds or review own draft |
| Resolver | Inspect published evidence and authorize a decision under immutable market rules | Separate assignment; reviewer/creator roles confer no resolver power |
| Platform administrator | Manage reviewer roles, categories, moderation and approved future contract versions | Cannot change deployed rules or withdraw user collateral |
| AI service | Generate structured draft suggestions, duplicate/ambiguity checks and evidence summaries | No private keys, arbitrary tools, publication approval or final settlement authority |

The initial factory rejects `reviewer == creator`. Operational policy also avoids a creator or financially interested person resolving their own market; enforcing beneficial ownership/conflicts is not solved by checking two different wallet addresses. The existing v1 resolver remains unchanged until a new version is deployed.

### Draft rules and state machine

Store drafts off-chain with owner wallet, origin (`manual` or `ai_assisted`), revision, question, category, metadata, trading close, observation time/window, resolution deadline, YES/NO/equality rules, sources and fallbacks, unavailable-data/Invalid treatment, collateral, fee, resolver/policy and requested implementation version. Closing trades before the observed event reduces information-timing ambiguity. AI suggestions must never silently replace the creator's text.

Draft → Submitted → ChangesRequested / Rejected / Approved. ChangesRequested returns to an editable draft. Editing an Approved draft creates a new revision and invalidates approval. Approval pins canonical deployment parameters, rules/metadata hashes, creator, reviewer, version, nonce, role epoch and expiry. The creator confirms those exact terms before signing. Expired, revoked, withdrawn or changed approvals cannot deploy. A confirmed deployment is recorded by chain receipt and address, not by a backend status alone.

Publication on the website follows confirmed deployment and verified initial liquidity. An unseeded v2 market is visible as Awaiting liquidity with trading disabled; it cannot pretend to offer executable quotes. Reviewer approval does not promise anyone will provide liquidity. An optional future atomic create-and-seed helper needs separate funding authorization and tests.

Once deployed, immutable rules cannot be edited; correction means a new market with a new identity. Moderation can remove a listing from discovery with a stated reason but cannot rewrite chain history, confiscate assets or remove direct claim/redemption access. Do not describe moderation as contract cancellation.

### AI acceptance criteria

“Improve with AI” returns validated structured suggestions: question, proposed criteria, suggested sources, duplicate candidates, ambiguity flags and unresolved questions. Proposed sources are suggestions until a human checks them. Reject unsupported data types, invalid times, unsupported collateral/assets and instruction-like tool requests. Limit request size, frequency and model cost. External pages and draft text remain untrusted; a model score cannot grant publication authority.

Begin with user-invoked assistance. Scheduled news-based suggestions can later enter an admin inbox, without auto-deployment. AI may prepare a settlement evidence packet, but the designated resolver still verifies and authorizes the outcome. AI factual accuracy is not established by its confidence score.

### Implementation order within M0–M4

1. Reproduce the source baseline; add draft/revision storage and a manual submission/reviewer workflow.
2. Add the bounded AI suggestion endpoint and explicit accept/edit controls; test both manual and AI-assisted paths.
3. Add factory role management and exact creator-plus-reviewer authorization before enabling reviewed on-chain publication.
4. Implement and verify share/AMM/LP accounting, then connect liquidity and trading pages.
5. Add resolver evidence review, version-aware indexing and the complete Testnet exercise.

Until step 3 is deployed, a review dashboard governs website listings only: the current v1 contract allows direct creator-authorized creation. Never claim off-chain review restricts that contract. Later template-based trusted publishing or public creation bonds require a new policy/version; unrestricted direct creation and AI auto-publication are excluded from this initial target.
