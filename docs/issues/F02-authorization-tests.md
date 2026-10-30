# Assert the exact Soroban authorization trees for staking, claims and settlement

**Status:** unassigned draft; not enrolled in Wave. **Suggested complexity:** Medium / 150 points, subject to review. **Estimated scope:** 2–3 days. **Area:** Soroban testing. **Reviewer:** repository owner must identify the active reviewer when publishing.

## Problem

The native tests exercise real token transfers and reject unauthenticated mutations, but most successful calls use `mock_all_auths`. They do not yet assert the complete address/function/argument/sub-invocation requirements for the financial paths.

## Outcome and scope

Extend `contracts/market/src/test.rs` with exact authorization-tree assertions for `predict`, `claim` and `settle_event`. Use explicit mocked authorization for successful calls where appropriate, and no/wrong authorization for rejection cases. Keep existing financial semantics unchanged.

Reference: [official authorization testing](https://developers.stellar.org/docs/build/guides/testing/test-contract-auth). Adapt examples to the pinned SDK rather than copying newer APIs without checking them.

## Acceptance criteria

- A stake asserts the actual user address, market/side/amount arguments and expected nested SAC transfer authorization; an unrelated user cannot authorize the stake.
- Settlement requires exactly the configured resolver with the supplied outcome, confidence and evidence arguments; a different account's authorization fails and market state remains unchanged.
- A claim requires the claimant; the outgoing contract-owned token transfer is handled correctly and cannot authorize another user's claim.
- Successful calls assert resulting balances/state as well as auth trees. Failed calls preserve balances/state.
- Tests would detect a removed `require_auth` or a change to which address authorizes settlement; explain this in the PR, using a local temporary mutation if helpful, without committing insecure contract changes.
- Existing contract and JavaScript checks continue to pass. No production contract behavior, ABI or artifact changes are included.

## Exclusions

Do not implement signer quorum, key rotation, report signatures, broad random fuzzing or a new contract authorization scheme. Those are separate work. Do not rely solely on `mock_all_auths` plus a successful return value as evidence.

## Validation

Run `npm run test:contracts` and the existing JavaScript suite. Include the new test names and assertion rationale. No funded account or paid service should be necessary.
