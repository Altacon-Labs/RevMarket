# Contributor map

| Area | Start here | Useful behavior to preserve |
|---|---|---|
| Contract | `contracts/market/src/lib.rs`, `contracts/market/src/test.rs` | Authenticated escrow, fixed closing time, one stake, final settlement, refunds, integer payouts |
| Client encoding | `shared/stellar.mjs`, `tests/runner.test.mjs` | Rust enum wire format, i128 amounts, prepare/sign/confirm transaction flow |
| Amounts | `shared/amount.mjs`, `tests/policy.test.mjs` | No floating-point money; 7-decimal XLM and 8-decimal USD |
| Resolution | `service/policy.mjs`, `service/providers.mjs`, `service/runner.mjs` | Conservative abstention, evidence persistence, provider independence assumptions |
| Operator loop | `service/worker.mjs` | Single resolver account, sequential submissions, retryable state scans |
| Frontend | `frontend/src/main.jsx`, `frontend/src/App.jsx`, `frontend/src/lib/wallet.mjs` | Modular React entry, Freighter account/network checks, on-chain positions, precise amounts, safe disabled states |
| Automation preview | `frontend/src/AutomationPanel.jsx`, `docs/AUTOMATION.md` | Draft only; no saved rules, wallet access, delegation or executable automation |
| Activity backend | `backend/app.mjs`, `backend/store.mjs`, `tests/backend.test.mjs` | Explicit sign-in, owner-scoped off-chain records; never financial or automation authority |
| Deployment | `scripts/testnet-smoke.mjs`, `docs/DEPLOYMENT.md` | Public-testnet checks clearly separated from fixture evidence; keys never saved |

First contribution: choose one [scoped issue draft](issues/README.md). Architecture context: [contract API](CONTRACT_API.md), [migration decisions](MIGRATION.md), [verified evidence](VERIFICATION.md), [limitations](LIMITATIONS.md). Automation design: [architecture](AUTOMATION.md). Long-term work: [backlog](DRIPS_WAVE_BACKLOG.md).

## Official Stellar references

- [Stellar CLI](https://developers.stellar.org/docs/tools/cli/stellar-cli): build, deploy and inspect contracts.
- [Contract authorization tests](https://developers.stellar.org/docs/build/guides/testing/test-contract-auth): assert required authorization trees.
- [Fuzzing](https://developers.stellar.org/docs/build/guides/testing/fuzzing): exercise unexpected payout and state combinations.
- [Restore a contract instance](https://developers.stellar.org/docs/tools/cli/cookbook/restore-contract-instance) and [restore contract storage](https://developers.stellar.org/docs/tools/cli/cookbook/restore-contract-storage): address archived-state support.
- [Freighter](https://docs.freighter.app/): wallet integration and real interaction testing.
- [Stellar JS SDK](https://stellar.github.io/js-stellar-sdk/): RPC, transaction handling and bindings.
- [Stellar oracles](https://developers.stellar.org/docs/data/oracles): evaluate data options; verify supported assets, timestamps and trust assumptions before adopting a provider.

Latest documentation can describe newer APIs than this repository's pinned SDKs. Check the lockfile version before copying an example; dependency upgrades require compatibility tests.
