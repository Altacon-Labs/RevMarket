import {signMessage} from '@stellar/freighter-api';
import {checkWallet} from './wallet.mjs';

export async function api(path, {method = 'GET', body, signal} = {}) {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    signal: signal || AbortSignal.timeout(5000),
    headers: body ? {'Content-Type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error('Activity service unavailable');
  }
  if (!response.ok) {
    const error = new Error(value.error || 'Activity service error');
    error.status = response.status;
    throw error;
  }
  return value;
}

export async function signInActivity(address, isCurrent = () => true) {
  await checkWallet(address);
  const challenge = await api('/auth/challenge', {method: 'POST', body: {wallet: address}});
  const prefix = `RevMarket sign-in\nOrigin: ${window.location.origin}\nNetwork: Stellar Testnet\nWallet: ${address}\n`;
  if (challenge.origin !== window.location.origin || challenge.wallet !== address || typeof challenge.message !== 'string' || !challenge.message.startsWith(prefix) || challenge.expiresAt <= Date.now() / 1000 || challenge.expiresAt > Date.now() / 1000 + 180) {
    throw new Error('Invalid activity sign-in challenge');
  }
  const signed = await signMessage(challenge.message, {address});
  if (signed.error || !signed.signedMessage || signed.signerAddress !== address) {
    throw new Error('Activity sign-in signature declined or signer changed');
  }
  await checkWallet(address);
  if (!isCurrent()) throw new Error('Wallet selection changed; sign in again');
  const signature = typeof signed.signedMessage === 'string'
    ? signed.signedMessage
    : btoa(String.fromCharCode(...signed.signedMessage));
  const result = await api('/auth/verify', {method: 'POST', body: {id: challenge.id, signature}});
  if (!isCurrent()) {
    await logoutActivity().catch(() => {});
    throw new Error('Wallet selection changed; sign in again');
  }
  return result;
}

export async function uploadMarketImage(file, wallet, isCurrent = () => true) {
  if (!file || file.size <= 0 || file.size > 5 * 1024 * 1024) throw new Error('Choose an image smaller than 5 MB.');
  await checkWallet(wallet);
  let profile = null;
  try {profile = await api('/me');} catch (error) {if (error.status !== 401) throw error;}
  if (profile?.wallet !== wallet) await signInActivity(wallet, isCurrent);
  await checkWallet(wallet);
  if (!isCurrent()) throw new Error('Wallet selection changed; upload again.');

  const form = new FormData();
  form.append('image', file, file.name);
  const response = await fetch('/api/market-image', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'X-Stellar-Wallet': wallet},
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
  let result;
  try {result = await response.json();} catch {throw new Error('Image upload service returned an invalid response.');}
  if (!response.ok) throw new Error(result.error || 'Market image upload failed.');
  if (typeof result.cid !== 'string' || !/^bafy[a-z2-7]{20,}$/.test(result.cid)) throw new Error('Image upload returned an invalid CID.');
  return result.cid;
}

export const logoutActivity = () => api('/logout', {method: 'POST'});

export async function reportActivity(wallet, action, txHash) {
  try {
    return await api('/activity', {method: 'POST', body: {wallet, action, txHash}});
  } catch (error) {
    if (error.status === 401 || error.status === 403) return null;
    throw error;
  }
}