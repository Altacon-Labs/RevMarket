# Validate the native-token and resolver configuration before enabling wallet writes

**Status:** unassigned draft; not enrolled in Wave. **Suggested complexity:** Medium / 150 points, subject to review. **Estimated scope:** 2–3 days. **Area:** Soroban/client/frontend. **Reviewer:** repository owner must identify the active reviewer when publishing.

## Problem

The frontend verifies Freighter's account and network, but it trusts a manually configured contract ID and labels every 7-decimal escrow token XLM. The contract does not expose its immutable token/resolver config through the current public API. A wrongly configured contract can therefore be displayed with the wrong token label.

## Outcome and scope

Add a read-only `get_config` API returning the existing token and resolver addresses, plus a public testnet deployment manifest containing contract ID, network passphrase, token and resolver. Before enabling any wallet write, verify the RPC network, contract config, manifest agreement and native SAC identity derived for that network. Read failures must leave writes disabled with an actionable explanation. Do not trust the manifest alone.

Starting files: `contracts/market/src/lib.rs`, `contracts/market/src/test.rs`, `shared/stellar.mjs`, `frontend/src/App.jsx`, `frontend/src/lib/wallet.mjs`, `docs/DEPLOYMENT.md`. Keep the validation logic isolated enough to test wrong configuration cases.

## Acceptance criteria

- A correctly deployed testnet/native-XLM contract passes validation without changing balances or market state.
- Wrong RPC network, token, resolver, missing manifest, malformed contract ID and an older instance without the getter all leave wallet writes disabled.
- A different 7-decimal token fails the native SAC check.
- Validation completes before creation, prediction, request or claim signatures are requested. Revalidation occurs when deployment configuration changes.
- Tests cover successful and failed validation; fixture RPC tests are labeled. Demonstrate the actual getter on a new testnet instance and document public evidence without keys.
- Document that older instances lack the getter; adding it requires deploying rebuilt WASM. Preserve access to old claims rather than silently switching addresses.

## Exclusions and compatibility

Do not change escrow math, close/deadline rules, resolver authority, storage layout, token mutability or mainnet support. WASM code-hash attestation, key rotation and multi-token UI are separate work. Regenerate a tracked compiled artifact only with its matching build hash and update verification evidence truthfully. Do not reuse the earlier smoke report as proof of the new binary.

## Validation

Run the existing JavaScript suite, contract suite and both builds. Add focused config/disabled-state coverage and record the new testnet getter check. Before merge, the maintainer must review the read-API compatibility change and all acceptance criteria.
