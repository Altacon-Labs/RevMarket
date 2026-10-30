# Opt-in position automation

## Current capability

The app has a non-operative planning preview. It does not persist preferences, request a signature or submit transactions. Enable is disabled. Existing bets, manual claims and resolution behavior are unchanged. No delegated permissions, executor or automatic betting currently exist in the contract or backend.

An independent [activity backend](../backend/README.md) now provides optional public-key sign-in, profiles and unverified client-reported activity. Its session does not grant on-chain permissions. A02 may build on its registration/storage boundary, but must read actual A01 permissions from the chain before execution. A profile is not an automation opt-in.

## Architecture and delivery order

| Layer | Responsibility | Delivery |
|---|---|---|
| Soroban market contract | Owner-authorized claim permission for one keeper, fixed expiry and immediate revocation; funds always paid to the owner | A01 |
| Separate backend executor | Discover eligible positions, verify permission and submit claims using its own fee-paying key | A02, after A01 |
| Frontend | Show confirmed permission state, wallet-approved enable/revoke, history and errors | A03, after A01/A02 |
| Future betting permission | Enforce explicit markets/sides, per-bet and cumulative budgets, expiry and revocation on-chain | A04 design first; implementation only after review |

The resolution worker remains responsible for outcomes, not user delegation. Do not reuse its resolver authority as authority to act for a user. Put future execution code under a separate `service/automation/` module; store no user secret keys. A backend cannot grant, extend or bypass permissions. Backend downtime affects convenience; users retain manual claim/refund access.

## First release: claim/refund only

Start with claims because they must not spend a user's wallet balance, choose an outcome, enter a new bet or redirect payouts. A keeper pays its own transaction fees. Granting and revoking require the owner. Every submitted claim checks the latest permission, keeper identity and ledger expiry; queued work is not authorization. Revocation prevents subsequent execution but cannot reverse already confirmed transactions.

Do not expose a working enable switch until contract, executor and UI acceptance checks pass together. Older contract instances lack this API; deploy a new instance and retain the old instance's manual claim interface. Do not silently replace deployed addresses or reuse earlier WASM verification as proof of new behavior.

## Later betting phase

Users must define allowed market IDs, sides, stake per action, total budget and expiry. Cumulative limits must be enforced atomically on-chain, not just by server settings. Design fee accounting, replay protection, one-position rules and concurrent submissions before implementation. No profit claims, autonomous market recommendations or early exits are included. Existing positions remain locked until payout/refund eligibility.

## Verification gates

Unauthorized grants/revocations, wrong keeper, expired/revoked permissions, duplicate claims, ineligible positions and payout redirection must fail without changing state. Test executor retries, uncertain confirmation, restarts, pending revocation and RPC failure. Complete a new WASM/testnet opt-in → claim → revoke → rejection flow before activating the app controls. Automated betting needs additional adversarial budget/replay tests and independent review.
