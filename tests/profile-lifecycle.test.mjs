import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@stellar/stellar-sdk';
import {openStore} from '../backend/store.mjs';
import {createApi} from '../backend/app.mjs';
import {
  PROFILE_LIFECYCLE_COPY,
  deleteActivityProfile,
  loadActivityProfileState,
  signOutActivityProfile,
} from '../frontend/src/lib/activity-profile.mjs';

const origin = 'http://127.0.0.1:5173';

async function createFixture(t) {
  const db = openStore(':memory:');
  let clock = 1000;
  const server = createApi({db, appOrigin: origin, now: () => clock, rateLimit: 1000});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    try {db.close();} catch {}
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookieJar = '';

  async function apiClient(path, {method = 'GET', body} = {}) {
    const headers = {Origin: origin};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookieJar) headers.Cookie = cookieJar;
    const response = await fetch(base + '/api' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      cookieJar = pair.endsWith('=') || /Max-Age=0/i.test(setCookie) ? '' : pair;
    }
    const value = await response.json();
    if (!response.ok) {
      const error = new Error(value.error || 'Activity service error');
      error.status = response.status;
      error.body = value;
      throw error;
    }
    return value;
  }

  async function login(key) {
    const challenge = await apiClient('/auth/challenge', {method: 'POST', body: {wallet: key.publicKey()}});
    const signature = Buffer.from(key.signMessage(challenge.message)).toString('base64');
    await apiClient('/auth/verify', {method: 'POST', body: {id: challenge.id, signature}});
  }

  return {db, apiClient, login, getCookie: () => cookieJar};
}

test('AC1: signed wallet can delete an empty profile; cancel leaves it intact', async t => {
  const f = await createFixture(t);
  const key = Keypair.random();
  await f.login(key);

  const initial = await loadActivityProfileState({address: key.publicKey(), apiClient: f.apiClient});
  assert.equal(initial.status, 'online');
  assert.equal(initial.profile.wallet, key.publicKey());
  assert.deepEqual(initial.items, []);

  // Cancel leaves profile and session intact
  const cancelled = await deleteActivityProfile({apiClient: f.apiClient, confirm: () => false});
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.deleted, false);
  const afterCancel = await loadActivityProfileState({address: key.publicKey(), apiClient: f.apiClient});
  assert.equal(afterCancel.profile.wallet, key.publicKey());

  // Confirmed deletion removes empty profile and clears session
  const deleted = await deleteActivityProfile({apiClient: f.apiClient, confirm: () => true});
  assert.equal(deleted.cancelled, false);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.onChainDataUnchanged, true);
  assert.equal(deleted.nextState.profile, null);
  assert.deepEqual(deleted.nextState.items, []);
  assert.equal(f.getCookie(), '');

  // Reload stays cleared
  const afterReload = await loadActivityProfileState({address: key.publicKey(), apiClient: f.apiClient});
  assert.equal(afterReload.status, 'online');
  assert.equal(afterReload.profile, null);
  assert.deepEqual(afterReload.items, []);
});

test('AC1 & AC2: deleting a profile with reports clears session and reports immediately and on reload; failed request stays retryable', async t => {
  const f = await createFixture(t);
  const key = Keypair.random();
  await f.login(key);

  await f.apiClient('/activity', {
    method: 'POST',
    body: {wallet: key.publicKey(), action: 'predict', txHash: 'a'.repeat(64)},
  });

  const before = await loadActivityProfileState({address: key.publicKey(), apiClient: f.apiClient});
  assert.equal(before.items.length, 1);

  // Failed DELETE keeps session and reports intact so the user can retry
  const failingClient = async (path, opts) => {
    if (path === '/me' && opts?.method === 'DELETE') {
      const err = new Error('Temporary backend failure');
      err.status = 500;
      throw err;
    }
    return f.apiClient(path, opts);
  };
  await assert.rejects(
    () => deleteActivityProfile({apiClient: failingClient, confirm: () => true}),
    /Temporary backend failure/,
  );
  const afterFailure = await loadActivityProfileState({address: key.publicKey(), apiClient: f.apiClient});
  assert.equal(afterFailure.profile.wallet, key.publicKey());
  assert.equal(afterFailure.items.length, 1);

  // Retry succeeds and clears session + private report list immediately and on reload
  const retried = await deleteActivityProfile({apiClient: f.apiClient, confirm: () => true});
  assert.equal(retried.deleted, true);
  assert.equal(retried.nextState.profile, null);
  assert.deepEqual(retried.nextState.items, []);

  const afterReload = await loadActivityProfileState({address: key.publicKey(), apiClient: f.apiClient});
  assert.equal(afterReload.profile, null);
  assert.deepEqual(afterReload.items, []);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM activity WHERE wallet=?').get(key.publicKey()).n, 0);
});

test('AC3: Settings and Activity share the same session; deletion preserves workflow records and copy accurately describes scope', async t => {
  const f = await createFixture(t);
  const key = Keypair.random();
  await f.login(key);

  // Create a creator workflow draft record owned by this wallet
  f.db.prepare(
    "INSERT INTO drafts(owner_wallet, origin, status, created_at, updated_at) VALUES(?, 'manual', 'draft', 1000, 1000)",
  ).run(key.publicKey());

  // Both Settings and Activity read the same active session
  const settingsView = await loadActivityProfileState({address: key.publicKey(), apiClient: f.apiClient});
  const activityView = await loadActivityProfileState({address: key.publicKey(), apiClient: f.apiClient});
  assert.equal(settingsView.profile.wallet, key.publicKey());
  assert.equal(activityView.profile.wallet, key.publicKey());

  // Sign out from one screen clears the session for the other
  await signOutActivityProfile({apiClient: f.apiClient});
  const afterSignOut = await loadActivityProfileState({address: key.publicKey(), apiClient: f.apiClient});
  assert.equal(afterSignOut.profile, null);

  // Sign back in and delete profile: creator/review workflow records remain intact
  await f.login(key);
  const deleted = await deleteActivityProfile({apiClient: f.apiClient, confirm: () => true});
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.onChainDataUnchanged, true);

  const remainingDrafts = f.db.prepare('SELECT COUNT(*) AS n FROM drafts WHERE owner_wallet=?').get(key.publicKey()).n;
  assert.equal(remainingDrafts, 1);

  // Copy accurately distinguishes Privy, retained creator/review workflow records, and on-chain positions
  assert.match(PROFILE_LIFECYCLE_COPY.deletionScopeSummary, /Privy/i);
  assert.match(PROFILE_LIFECYCLE_COPY.deletionScopeSummary, /creator\/review/i);
  assert.match(PROFILE_LIFECYCLE_COPY.deletionScopeSummary, /on-chain/i);
  assert.match(PROFILE_LIFECYCLE_COPY.deleteConfirmMessage, /Privy/i);
  assert.match(PROFILE_LIFECYCLE_COPY.deleteConfirmMessage, /creator\/review/i);
  assert.match(PROFILE_LIFECYCLE_COPY.deleteConfirmMessage, /on-chain/i);
});
