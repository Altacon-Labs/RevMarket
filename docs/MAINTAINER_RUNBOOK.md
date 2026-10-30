# Maintainer runbook

The repository owner is the initial accountable maintainer. Only explicitly appointed repository reviewers may approve changes. Before enrollment, identify the active reviewer in each published issue and confirm they are available for the cycle. This package does not claim anyone has accepted a response-time commitment.

## Before the sprint

- Publish the prepared code and preserve license notices. Run GitHub CI on the intended default branch.
- Enable GitHub private vulnerability reporting if available and confirm a private contact route. Review SECURITY.md after choosing that route.
- Verify Drips repository approval, cycle deadline/timezone, available repo/org budgets and actual label/complexity settings.
- Publish the three issue drafts separately; remove or defer any task already implemented. Scope each for a single contributor and identify dependencies.
- Enroll only the work that fits the confirmed budget and reviewer capacity. Do not preassign unverified participants or promise fixed dollar rewards.

## During the sprint

Check applications and PRs daily while participating. Assign through the supported Drips/GitHub workflow, clarify expected scope, and acknowledge blockers early. Use relevant examples and proposed approach alongside applicant metrics. Give concrete review feedback. Resolve assignment disputes in the issue; use Drips support for program disputes. Do not share identity information or secrets in public discussions.

## Review checklist

- Reproduce the linked problem and verify every acceptance criterion; do not accept implementation-mirroring tests as sole evidence.
- Require appropriate financial/auth negative cases, exact amounts and trust-model documentation.
- Check that ABI/storage/policy changes have an explicit compatibility plan.
- Verify actual checks and evidence; distinguish native host, mocked transport and deployed WASM.
- Preserve license notices and reject secret-bearing/generated files.
- Merge reviewed code when ready. For Wave work, verify the assigned issue is closed as completed/resolved before the current cycle ends; inspect points status. Do not close unfinished work to manufacture points. If external blockers prevent merge of otherwise accepted work, consult the program's documented resolution guidance.

After the cycle, review carried-over issues and budget use, record remaining blockers, and use the app's feedback/review features. Confirm current bonus and review rules before promising them. Governing program sources are linked in [WAVE_GUIDE.md](WAVE_GUIDE.md).
