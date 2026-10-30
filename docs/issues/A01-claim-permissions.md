# Add revocable, expiring claim-only keeper permissions on Soroban

**Status:** unassigned draft, not enrolled. **Suggested complexity:** High / 200 points. **Estimated effort:** 3–5 days. **Prerequisites:** agreed architecture in `docs/AUTOMATION.md`. The owner identifies the reviewer before enrollment.

## Problem and scope

Claims currently require the claimant's direct authorization. Add an owner-authorized permission for one keeper to claim eligible winnings/refunds on the owner's behalf. Include grant, revoke, permission getter and delegated claim entrypoints. Expiry and revocation are enforced in the contract. Payout destination is always the owner; the keeper cannot bet, move wallet funds, change outcomes or supply a different recipient.

Start in `contracts/market/src/lib.rs`, `contracts/market/src/test.rs`, `docs/CONTRACT_API.md`. Reuse internal payout logic while preserving the existing manual claim interface and economics. Define bounded permission expiry, storage TTL and archived-entry handling. Missing/archived permission must fail closed, never infer consent.

## Acceptance criteria

- Only the owner grants/revokes; only the currently allowed keeper can execute before expiry. Grants cannot be created by the backend or resolver role.
- Permission state is checked for each execution; revoked, expired, missing and wrong-keeper requests fail atomically.
- Both winning and eligible timeout/no-winner refunds pay the original owner, never the keeper. No early/duplicate/loser payout is introduced.
- Existing manual claims continue to work without opting in; existing accounting and all current tests remain correct.
- Exact auth and balance assertions cover successful delegation, wrong identities, expiry boundary, revocation and attempts to redirect payout.
- Document the additive ABI/new-deployment requirement. Provide rebuilt-WASM evidence from a new testnet instance with temporary keys, preserving old-instance manual access.

## Exclusions and review

No automatic betting, wallet custody, executor, frontend activation or outcome-resolution changes. Review permission lifecycle and nested token authorization before merging. Run contract tests, release WASM build and existing JavaScript checks. Do not activate the planning preview based on this contract-only task.
