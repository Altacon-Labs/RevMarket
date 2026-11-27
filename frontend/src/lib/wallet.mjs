import {requestAccess, getAddress, getNetworkDetails, signTransaction, isConnected, isAllowed} from '@stellar/freighter-api';
import {Networks} from '../../../shared/stellar.mjs';

import {hasWalletOptIn, setWalletOptIn} from './wallet-preferences.mjs';
export {hasWalletOptIn, setWalletOptIn} from './wallet-preferences.mjs';

function e2eWallet() {
  return import.meta.env?.VITE_E2E_TEST_MODE === 'true' && typeof window !== 'undefined'
    ? window.__REVMARKET_E2E__?.wallet || null
    : null;
}

export async function checkWallet(expectedAddress) {
  const fixture = e2eWallet();
  const [account, network] = fixture
    ? await Promise.all([fixture.getAddress(), fixture.getNetworkDetails()])
    : await Promise.all([getAddress(), getNetworkDetails()]);
  if (account.error || !account.address || account.address !== expectedAddress) {
    throw new Error('Wallet account changed. Reconnect before continuing.');
  }
  if (network.error || network.networkPassphrase !== Networks.TESTNET) {
    throw new Error('Switch Freighter to Stellar Testnet');
  }
}

export async function connect() {
  const fixture = e2eWallet();
  const result = fixture ? await fixture.requestAccess() : await requestAccess();
  if (result.error || !result.address) throw new Error('Freighter connection was declined or the extension is unavailable');
  await checkWallet(result.address);
  return result.address;
}

export async function getExistingAddress() {
  try {
    const fixture = e2eWallet();
    if (fixture) {
      const installed = await fixture.isConnected();
      if (!installed) return null;
      const allowed = await fixture.isAllowed();
      if (!allowed) return null;
      const account = await fixture.getAddress();
      if (!account?.address) return null;
      const network = await fixture.getNetworkDetails();
      return !network?.error && network?.networkPassphrase === Networks.TESTNET ? account.address : null;
    }
    const installed = await isConnected();
    if (!installed || installed.error) return null;
    const allowed = await isAllowed();
    if (!allowed || allowed.error || !allowed.isAllowed) return null;
    const account = await getAddress();
    if (account.error || !account.address) return null;
    const network = await getNetworkDetails();
    if (network.error || network.networkPassphrase !== Networks.TESTNET) return null;
    return account.address;
  } catch {
    return null;
  }
}

export function signer(address) {
  return async (xdr, networkPassphrase) => {
    await checkWallet(address);
    const fixture = e2eWallet();
    const result = fixture
      ? await fixture.signTransaction(xdr, {networkPassphrase, address})
      : await signTransaction(xdr, {networkPassphrase, address});
    if (result.error || !result.signedTxXdr) throw new Error('Transaction signature declined');
    if (result.signerAddress && result.signerAddress !== address) throw new Error('Wallet signer changed');
    return result.signedTxXdr;
  };
}
