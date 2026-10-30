# Explicit limitations

- The local activity backend uses Node's experimental SQLite API and supports a single loopback process. It proves control of a public signing key, not current ledger signer thresholds. Activity is client-reported, not independently verified. No chain indexer or automation executor exists. Interactive Freighter message signing remains a manual acceptance step. Production TLS/routing, authentication review, distributed limits, backups and privacy operations require further work.

- Automation is a planning preview only: enable is disabled, drafts are not persisted, and no wallet permission or transaction is requested. On-chain opt-in/revocation, the executor and real activation are staged Wave issues. Automatic betting has not been implemented.

- Testnet only; no audit, production deployment, economic review, mainnet support or security guarantee.
- A single resolver key is trusted. Median, source independence, freshness and quorum are worker policy, not independently verified by the contract. There are no signed provider attestations or decentralized consensus.
- Live API calls may be unavailable, rate limited, geoblocked, delayed or dishonest. Price timestamps record local receipt time rather than provider-signed market timestamps. The narrow observation policy intentionally abstains if missed.
- No event evidence service is bundled. Event creation/staking/refunds work, but automatic event settlement requires at least two real, configured evidence providers. The service does not browse the web or ask Gemini for facts.
- One worker per resolver account. Polling and sequential scans support at most 1,000 markets; the frontend shows the latest 50. Production indexing, queues, schedule guarantees, multi-process coordination and alerting remain backlog work.
- Evidence is persisted to the worker filesystem and its hash is committed on-chain. Durable replicated hosting and an evidence retrieval UI/API are not implemented.
- Storage archival requires operator/user restoration tooling. Reads via simulation do not renew storage TTL. Submitted `keepalive` calls and monitoring are required for long-delayed claims.
- Payouts round down; dust is permanently retained in contract escrow. No sweep exists. The pool cap avoids multiplication overflow.
- The token must be the native XLM SAC at deployment; the contract accepts any 7-decimal token and the frontend always labels it XLM. The deployer must verify the token ID. Arbitrary token support is not implemented.
- The original upload and historical source are preserved outside this delivery. No historical source tree or Git history is included.
- The frontend preserves the core transaction flows, not the entire original presentation/features. IPFS CID metadata is retained; authenticated pinning, rich notifications, agents, category views and hosted integrations remain future work.
- Browser wallet approval, account switching, public-testnet resets, contract restoration, actual provider outages and fee volatility need live operational testing beyond the automated suite. See `VERIFICATION.md` for exact results.
- No Drips registration, Wave eligibility determination, reward amounts, published issues or contributor assignments have been made. The backlog is a local, ready-to-review handoff.
