import {requestAccess, getAddress, getNetworkDetails, signTransaction} from '@stellar/freighter-api';
import {Networks} from '../../../shared/stellar.mjs';

export async function checkWallet(expectedAddress) {
  const [account, network] = await Promise.all([getAddress(), getNetworkDetails()]);
  if (account.error || !account.address || account.address !== expectedAddress) {
    throw new Error('Wallet account changed. Reconnect before continuing.');
  }
  if (network.error || network.networkPassphrase !== Networks.TESTNET) {
    throw new Error('Switch Freighter to Stellar Testnet');
  }
}

export async function connect() {
  const result = await requestAccess();
  if (result.error || !result.address) throw new Error('Freighter connection was declined or the extension is unavailable');
  await checkWallet(result.address);
  return result.address;
}

export function signer(address) {
  return async (xdr, networkPassphrase) => {
    await checkWallet(address);
    const result = await signTransaction(xdr, {networkPassphrase, address});
    if (result.error || !result.signedTxXdr) throw new Error('Transaction signature declined');
    if (result.signerAddress && result.signerAddress !== address) throw new Error('Wallet signer changed');
    return result.signedTxXdr;
  };
}