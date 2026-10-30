# RevMarket frontend

This React/Vite client is the Stellar testnet interface. Dependencies are managed as a workspace from the repository root; use the root `package-lock.json` and do not install or lock dependencies from this directory.

From the repository root:

```sh
npm ci
copy frontend/.env.example frontend/.env
npm run dev
```

Set `VITE_CONTRACT_ID` in `frontend/.env` to the deployed Soroban contract ID. `VITE_PRIVY_APP_ID` enables Privy email OTP and supported web3-wallet sign-in; enable both login methods in the Privy dashboard. Privy account authentication is separate from Freighter, which remains the Stellar transaction signer. `VITE_RPC_URL` defaults to Stellar Testnet. `VITE_IPFS_GATEWAY` is an optional public HTTPS gateway override. Event artwork uploads use the backend `PINATA_JWT`; set it in the backend process environment, never in the frontend `.env`. The backend accepts one JPEG, PNG, or WebP up to 5 MB and stores only the returned CID in the market contract. `VITE_READ_ACCOUNT` is optional and public; it only enables disconnected read simulations. Never place wallet secrets or API tokens in Vite variables.

Use `npm run build` at the repository root to verify the frontend bundle. The local activity backend is optional and is started separately with `npm run backend`.
