# Build a separate restart-safe executor for authorized claims and refunds

**Status:** staged draft, not enrolled. **Suggested complexity:** High / 200 points. **Dependency:** accepted and deployed A01 API; do not enroll before it is available. Reviewer and estimated effort must be confirmed against the final API.

Create `service/automation/` separately from the outcome-resolution worker. Discover eligible user positions through explicitly registered opt-ins, verify current on-chain permissions and submit claim-only transactions with the keeper's own fee-paying key. Do not collect user keys or treat local preferences as authorization.

The existing `backend/` profile/session/activity foundation is already implemented. Reuse its storage boundary where appropriate; do not nominate it as new work or mistake its public-key session/client-reported history for delegation or verified positions. Verified ingestion is a separate unimplemented item in `backend/TODO.md` and needs later scoping.

## Acceptance criteria

- Only eligible, unclaimed positions with matching current permissions are submitted; the contract remains the final authorization authority.
- Serialize transactions per keeper account; bound fees, scan size, retries and RPC timeouts. Persist transaction IDs before retry decisions and reconcile unknown/pending outcomes after restart.
- Revocation/expiry, duplicate delivery, two competing workers, insufficient fee balance and RPC errors are covered with realistic transport tests; no blind resubmission after an uncertain result.
- Emit sanitized action status without user keys or private configuration. The operator can stop scheduling immediately; users can revoke on-chain independently.
- Run an actual testnet claim and refund where practical; clearly distinguish advanced-ledger local refund tests from public-network timing.

No outcome decisions, betting, arbitrary fund transfers or frontend activation. Document deployment, key separation and recovery. A03 activates the UI only after end-to-end verification.
