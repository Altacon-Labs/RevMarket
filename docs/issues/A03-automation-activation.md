# Activate claim automation controls against verified on-chain permissions

**Status:** staged draft, not enrolled. **Suggested complexity:** Medium / 150 points. **Dependencies:** A01 and A02 accepted and verified together.

Replace the non-operative preview in `frontend/src/AutomationPanel.jsx` with wallet-approved grant/revoke actions and confirmed permission state. Show keeper, expiry, active/revoked/expired/pending/error states and claim history. Do not equate a saved draft or a running backend with an active grant.

Acceptance: wrong wallet/network or unsupported contract blocks activation; cancel/failure leaves permissions unchanged; confirmed revocation is reflected from chain; switching accounts clears stale state; backend downtime is visible; local UI state cannot override on-chain permission. Test keyboard/mobile flows, rejected signatures, expiry, RPC failure and account changes. Record a real grant → delegated claim → revoke → rejected future execution flow using new WASM evidence. Preserve manual claims. No automatic betting or private-key entry.
