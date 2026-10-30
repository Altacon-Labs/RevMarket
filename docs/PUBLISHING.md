# Publish and apply

## Publish the prepared project

1. Extract the ZIP. Use the contents of `RevMarket-stellar/` as the repository root, so `README.md`, `LICENSE`, `package.json` and `.github/` are at the top level. Include hidden configuration files.
2. Use the intended public GitHub repository. If updating an existing checkout, first preserve local work and use a review branch. Use the prepared Stellar tree as authoritative. Preserve any historical source separately, outside the published project; do not merge historical frontend files into this tree.
3. Publish only this prepared project. Do not publish the parent `work/` directory, the original ZIP, local toolchains/caches, `.env`, keys, `.git` from another checkout or `node_modules`. The included manifest lists the intended package files.
4. Keep `LICENSE` and `NOTICE.md`, including the original third-party notices. MIT covers the Stellar implementation; installed dependencies retain their respective licenses.
5. Enable Actions and run the `Stellar checks` workflow on the intended default branch. It requires no resolver secret or funded account. Resolve any hosted-run failure before claiming hosted CI success.
6. Enable private vulnerability reporting if available, verify a private maintainer contact, and identify the active reviewer. Set branch protection to require the JavaScript and contract checks after their first successful run, if available for the repository.

## Publish the initial issues

Create three separate GitHub issues by copying the titles and bodies in `docs/issues/A01-claim-permissions.md`, `F02-authorization-tests.md` and `F03-evidence-verifier.md`. Each must name its actual reviewer before enrollment. Use GitHub issue numbers in later PR closing references; the A01/F02/F03 filenames are local draft IDs, not published issue numbers. No task is assigned merely by being published.

## Apply

Open [Drips Wave](https://www.drips.network/wave), sign in with GitHub, and follow [maintainer onboarding](https://docs.drips.network/wave/maintainers/participating-in-a-wave/). The documentation describes organization/app setup; confirm the supported arrangement if the repository is personally owned. Sync the public repository and apply to the Stellar program. Use the description in [APPLICATION.md](APPLICATION.md), add the real public repository URL, and provide the verification/issue links requested in the live form.

Organizer approval, live dates, application limits and points budget are external steps. After approval, nominate only the issues that fit the available budget, set their actual complexity in the dashboard, and wait for contributor applications. The package proposes one High and two Medium tasks totaling 500 proposed points; it does not promise approval or a funding amount.
