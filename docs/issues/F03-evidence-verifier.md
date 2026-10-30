# Verify a locally selected evidence JSON against a market's on-chain digest

**Status:** unassigned draft; not enrolled in Wave. **Suggested complexity:** Medium / 150 points, subject to review. **Estimated scope:** 2–3 days. **Area:** frontend/security UX. **Reviewer:** repository owner must identify the active reviewer when publishing.

## Problem

The frontend displays a settlement evidence hash and asks users to obtain the JSON from the operator, but cannot verify that a selected file matches the recorded bytes. A matching digest would prove file integrity against the commitment, not that the outcome is factually true.

## Outcome and scope

Add a local file-selection verifier to settled/refundable market details. Hash the original file bytes with browser SHA-256, compare them with `Market.evidence`, and separately verify the version-1 evidence fields bind to the selected contract/market/question/close time. Render a small escaped summary and clear integrity/binding/error states. Do not upload files or fetch arbitrary evidence URLs.

Starting files: `frontend/src/App.jsx`, `frontend/src/index.css`, `service/runner.mjs` (schema reference only), `service/policy.mjs` (hashing reference), `docs/DEPLOYMENT.md`. Add a small browser-compatible verifier module and focused tests. Use files in `docs/smoke-evidence/` as existing fixtures, not as real-world evidence.

## Acceptance criteria

- The exact saved smoke evidence bytes match the stored digest; a one-byte or whitespace change fails integrity validation.
- A wrong contract ID, market ID, question, closing time or unsupported version is clearly rejected, even if the supplied digest matches that file's bytes.
- Malformed JSON, an empty selection, a file over 1 MiB and missing/all-zero evidence have clear safe states. Clear previous success when switching markets or files.
- Evidence text is rendered escaped, never as HTML. Evidence URLs are not fetched or opened automatically; no private file content leaves the browser.
- Show: "Digest match verifies these bytes against the recorded commitment; it does not verify the outcome or source truthfulness."
- Desktop/mobile and keyboard file-selection paths remain usable; include screenshots and test results. The contract ABI and settlement rules are unchanged.

## Exclusions

No evidence hosting, backend upload endpoint, IPFS pinning, arbitrary remote fetching, provider authentication or decentralized oracle claims. A missing file remains a documented operator availability limitation.

## Validation

Run the existing JavaScript suite and frontend build, plus the new integrity/binding/size cases. Exercise the file picker in a browser. No production funds, private keys or paid services are required.
