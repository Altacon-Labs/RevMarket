# Design bounded on-chain betting authorization before implementation

**Status:** roadmap design draft, not enrolled. **Suggested complexity:** High / 200 points; re-scope after review. **Dependency:** claim automation security/lifecycle lessons from A01–A03.

Specify an explicit, owner-signed policy containing allowed markets/sides, per-bet stake, cumulative spend ceiling, expiration and revocation. Define atomic budget accounting, replay protection, policy generations, transaction-fee responsibility and one-position-per-market compatibility. A backend's choices must remain inside contract-enforced bounds. Do not introduce market selection/recommendation logic or profit promises.

Acceptance: an implementation-ready specification, threat model, API/storage/deployment plan and adversarial test matrix covering budget exhaustion, concurrent submissions, stale policies, front-running/revocation ordering, replay and failed transfers. Explain which facts are on-chain vs backend-supplied. Review before creating separate implementation issues. This task does not authorize deployment of automated betting or activation of its UI.
