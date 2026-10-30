# Unimplemented expansion placeholders

The backend foundation covers public-key sign-in, own profile/session lifecycle and explicitly unverified client reports. The following are deliberately unimplemented. This list is not an enrolled, funded or assigned contribution batch.

- [ ] Verified Stellar transaction ingestion and derived position history; client reports must not be promoted to verified facts without checking contract, network, actors and finality.
- [ ] Pagination/export, reviewed database migrations and deployment-specific retention/backups.
- [ ] Reviewed account authentication if ledger signer thresholds, multisig or contract identities become necessary; current login proves one public signing key only.
- [ ] Integration with real on-chain opt-in, expiry and revocation after A01. A session or profile is never delegation consent.
- [ ] A separate claim/refund executor after accepted on-chain permissions; no scheduling or financial execution exists in this API.
- [ ] Verified app enable/revoke controls and automation history after the contract/executor flow passes end-to-end checks.
- [ ] Bounded automated betting only after a reviewed design and contract-enforced spending limits. No enabled betting control or execution endpoint is included.

The existing automation Wave drafts remain planning material in `docs/issues/`. These TODOs are placeholders for later scoping; they do not implement or authorize those features.
