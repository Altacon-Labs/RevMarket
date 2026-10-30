# Testnet deployment and operations guide

This document explains how to build, deploy, and operate the RevMarket Stellar delivery on testnet without relying on hidden assumptions or local-only configuration.

## 1. Build and deploy

Install Rust and the official Stellar CLI using the official Stellar setup guide. Use testnet keys only. The generated local identities contain secrets and must never be committed to the repository or included in a ZIP.

```sh
stellar keys generate deployer --network testnet --fund
stellar keys generate resolver --network testnet --fund
stellar keys address resolver
cd contracts
rustup target add wasm32v1-none
cargo test --locked --lib
cargo build --locked --release --target wasm32v1-none
stellar contract id asset --asset native --network testnet
```

Record the public resolver address and the native Stellar Asset Contract ID printed by the CLI, then deploy the contract with the required constructor arguments:

```sh
stellar contract deploy --wasm target/wasm32v1-none/release/revmarket.wasm --source-account deployer --network testnet -- --token NATIVE_SAC_C_ADDRESS --resolver RESOLVER_G_ADDRESS
```

Important implementation constraints:

- the constructor verifies 7 decimal places on the configured token
- the operator must pass the native SAC address, not an arbitrary token address
- the token and resolver are immutable in this release
- to rotate, deploy a new instance and leave the old instance available for claims or refunds
- if the installed Stellar CLI differs from the command expectations, check the version-specific help output before running a deployment command

This package does not ship a bundled Stellar CLI binary.

## 2. Configure the frontend

Copy the example frontend environment file and set the deployed contract address:

```sh
cp frontend/.env.example frontend/.env
```

Set the following values in the frontend environment:

- `VITE_CONTRACT_ID`: deployed C-address for the market contract
- `VITE_READ_ACCOUNT`: optional public funded testnet G-address for disconnected reads
- `VITE_*`: public values only, never a private key

The default RPC is `https://soroban-testnet.stellar.org`.

Then run:

```sh
npm run dev
```

In Freighter, select Stellar Testnet and fund a wallet with Friendbot. The app checks the selected account and network before each signature. Reads are simulated; mutations simulate, prepare, sign, submit, and then poll for a confirmed success result.

Timeout and failed transaction messages include a transaction hash. Check the hash before retrying. This prototype client rejects transaction fees above 1 XLM.

The app displays the latest 50 markets and uses the on-chain creator and position records for personal filters. It polls Stellar RPC for updated state. If a transaction confirms just before a later refresh fails, it may still have succeeded; inspect the transaction hash before assuming it failed.

## 3. Run the resolution worker

Set the worker environment variables in your process manager or local shell. The following values are used:

| Variable | Meaning |
|---|---|
| `CONTRACT_ID` | deployed market C-address |
| `RESOLVER_SECRET` | resolver secret for the configured resolver G-address; server-only |
| `STELLAR_RPC_URL` | optional HTTPS testnet RPC endpoint |
| `EVENT_SOURCE_URLS` | JSON array of 2–5 operator-configured evidence endpoints on distinct hosts |
| `RUN_ONCE` | set to 1 for a single scan; otherwise the worker scans every 10 seconds |

Start the worker:

```sh
npm run resolve
```

Operational requirements:

- run one process per resolver account
- parallel workers can collide on account sequence numbers
- the worker scans at most 1,000 markets
- it requests closed markets, gathers evidence, writes exact JSON under `service/evidence/<sha256>.json`, and submits settlement
- it checks state before sending and again on each rescan
- failed or inconclusive sources defer resolution rather than guessing
- use a dedicated scheduler or indexer before increasing volume

Evidence providers are configured by the operator, never by the market question text. The worker adds a `?marketId=<integer>` query parameter to each event endpoint and expects a response like this:

```json
{
  "marketId": 4,
  "questionHash": "SHA256_OF_JSON_STRINGIFIED_EXACT_QUESTION",
  "outcome": 0,
  "confidence": 9000,
  "observedAt": 1793190000,
  "evidenceUrl": "https://publisher.example/evidence/4"
}
```

Important interpretation rules:

- `outcome`: 0 means YES, 1 means NO
- `observedAt`: integer Unix seconds after closing, no more than 1 hour old, and no more than 5 seconds in the future
- `confidence`: integer basis points in the 8000–10000 range
- question hashing is `createHash('sha256').update(JSON.stringify(question)).digest('hex')`
- hostnames identify providers, but separate hosts do not prove independent ownership
- response-provided `source` is ignored
- redirects and non-HTTPS endpoint URLs are rejected
- the service checks the evidence URL scheme but does not fetch, verify, or authenticate the remote content

Endpoint operators must provide truthful and independently verified facts. Do not connect untrusted proxies.

## 4. Manual smoke test

Follow this sequence to validate the flow end-to-end:

1. Create a price market that closes in 2–3 minutes and start the worker before close.
2. Use two funded Freighter test accounts to take opposite positions.
3. After close, confirm new predictions are rejected and the request status appears.
4. Confirm settlement and locate the matching evidence file. The SHA-256 over its exact bytes must match the on-chain digest.
5. Claim with the winning account and compare balances before and after, allowing for XLM transaction fees. A second claim must fail.
6. For event markets without configured providers, verify abstention; after close plus the 24-hour period, claim the refund path.

Manual Freighter signatures and real public API behavior are separate from automated unit tests. See [VERIFICATION.md](VERIFICATION.md) for the local verification work performed in this repo.

## 5. Storage lifecycle and TTL notes

Writes extend the instance, market, and touched position TTL toward 1,036,800 ledgers, roughly 60 days at 5 seconds per ledger. Simulation reads do not persist these extensions.

Submit `keepalive(id, user)` periodically for positions that still need a claim. It extends the relevant entries without requiring the user’s signature. Operators pay storage fees.

Once entries are archived, they must be restored using Stellar restoration tooling before this client can use them; automatic restoration is not implemented. Back up contract IDs, claimant addresses, and evidence, and monitor TTLs and resolver balance.

## References

- [Stellar JS SDK](https://github.com/stellar/js-stellar-sdk)
- [Soroban SDK](https://docs.rs/soroban-sdk/23.0.3/soroban_sdk/)
- [Freighter API](https://github.com/stellar/freighter/tree/master/%40shared/api)
- [Stellar storage documentation](https://developers.stellar.org/docs/build/smart-contracts/storage/persisting-data)
