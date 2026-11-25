# Manual Freighter Testnet browser checklist

The automated browser suite uses a deterministic wallet and RPC fixture. It does **not** connect to Freighter, submit transactions, or claim live-chain evidence.

Run the manual check only with a disposable Testnet wallet and the current deployment details.

- [ ] Network selected in Freighter: Stellar Testnet
- [ ] Contract ID used: `<record the actual deployed contract ID>`
- [ ] Browser and OS: `<record>`
- [ ] Settings: connect wallet, verify role, add/revoke a reviewer, switch wallets, and confirm the previous session is cleared
- [ ] Creator: save and submit an intent using one wallet
- [ ] Reviewer: decide the submitted revision using a distinct reviewer wallet
- [ ] Creator: open and reload the publication intent; confirm it remains off-chain and is not shown as a minted market
- [ ] Legacy market: take a position, confirm the Freighter prompt, and record the successful transaction hash
- [ ] Ingest the resulting event and record the ingestion checkpoint / ledger
- [ ] Resolve the market, inspect the evidence digest and status in the browser, then claim and refresh the portfolio
- [ ] Exercise a timeout refund and record its transaction hash
- [ ] Exercise wallet rejection, API outage, and stale-checkpoint behavior
- [ ] Confirm reviewed off-chain intents remain separate from legacy on-chain market creation and from future factory deployment

## Live run evidence

| Field | Result |
|---|---|
| Network | Not run in CI |
| Contract ID | Not run in CI |
| Position transaction hash | Not run in CI |
| Resolution transaction hash | Not run in CI |
| Claim/refund transaction hash | Not run in CI |
| Browser result | Not run in CI |

Do not fill these fields with fixture values. Record only values observed during an actual Freighter Testnet session.
