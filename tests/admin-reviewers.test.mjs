import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Keypair} from '@stellar/stellar-sdk';
import {openStore} from '../backend/store.mjs';
import {createApi} from '../backend/app.mjs';
import {
  addAdminReviewer,
  getAdminNetwork,
  getCurrentSession,
  listAdminReviewers,
  revokeAdminReviewer,
  validateReviewerWallet,
} from '../frontend/src/lib/backend.mjs';
import {
  REVOCATION_EFFECTS,
  createAdminSettingsController,
  formatAuditTimestamp,
  isAdminAuthorizedForWallet,
  partitionReviewers,
} from '../frontend/src/lib/admin-settings.mjs';

const origin = 'http://127.0.0.1:5173';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, resolve, reject};
}

async function apiFixture(t, {superAdminWallets = []} = {}) {
  const db = openStore(':memory:');
  let clock = 1_764_000_000;
  const server = createApi({
    db,
    appOrigin: origin,
    now: () => clock,
    rateLimit: 1000,
    superAdminWallets,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  let browserCookie = '';

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' && input.startsWith('/api')
      ? base + input
      : input;
    const headers = new Headers(init.headers || {});
    if (!headers.has('Origin')) headers.set('Origin', origin);
    if (browserCookie && !headers.has('Cookie')) headers.set('Cookie', browserCookie);
    const response = await originalFetch(url, {...init, headers});
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0];
      browserCookie = pair.endsWith('=') ? '' : pair;
    }
    return response;
  };

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    db.close();
  });

  async function callRaw(path, {method = 'GET', body, cookie} = {}) {
    const headers = {Origin: origin};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const response = await originalFetch(base + '/api' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }

  async function loginWithKeypair(keypair) {
    const challenge = await callRaw('/auth/challenge', {
      method: 'POST',
      body: {wallet: keypair.publicKey()},
    });
    assert.equal(challenge.status, 200);
    const verified = await callRaw('/auth/verify', {
      method: 'POST',
      body: {
        id: challenge.body.id,
        signature: Buffer.from(keypair.signMessage(challenge.body.message)).toString('base64'),
      },
    });
    assert.equal(verified.status, 200);
    return verified.cookie;
  }

  function createWalletSigner(keypairsByWallet) {
    let signInCalls = 0;
    async function signIn(wallet, isCurrent = () => true) {
      signInCalls += 1;
      const keypair = keypairsByWallet.get(wallet);
      if (!keypair) throw new Error(`No fixture keypair for ${wallet}`);
      const challenge = await callRaw('/auth/challenge', {
        method: 'POST',
        body: {wallet},
      });
      assert.equal(challenge.status, 200);
      if (!isCurrent()) throw new Error('Wallet selection changed; sign in again');
      const verified = await callRaw('/auth/verify', {
        method: 'POST',
        body: {
          id: challenge.body.id,
          signature: Buffer.from(keypair.signMessage(challenge.body.message)).toString('base64'),
        },
      });
      assert.equal(verified.status, 200);
      if (!isCurrent()) throw new Error('Wallet selection changed; sign in again');
      browserCookie = verified.cookie;
      return verified.body;
    }
    return {
      signIn,
      getSignInCalls: () => signInCalls,
    };
  }

  return {
    db,
    callRaw,
    loginWithKeypair,
    createWalletSigner,
    getCookie: () => browserCookie,
    setCookie: value => {
      browserCookie = value;
    },
    advanceClock: seconds => {
      clock += seconds;
    },
  };
}

test('W28 AC1: allowlisted signed wallet can list, add, revoke and re-add reviewers with reload persistence and revocation side effects', async t => {
  const admin = Keypair.random();
  const reviewer = Keypair.random();
  const creator = Keypair.random();
  const f = await apiFixture(t, {superAdminWallets: [admin.publicKey()]});
  const signer = f.createWalletSigner(new Map([[admin.publicKey(), admin]]));

  const controller = createAdminSettingsController({
    initialAddress: admin.publicKey(),
    signIn: signer.signIn,
  });

  // Initial verify signs in once, loads network access and empty reviewer list
  const verified = await controller.verifySuperAdmin();
  assert.equal(verified.ok, true);
  assert.equal(signer.getSignInCalls(), 1);
  assert.equal(isAdminAuthorizedForWallet(controller.getState(), admin.publicKey()), true);
  assert.deepEqual(controller.getState().reviewers, []);

  // Add reviewer and refresh from API
  const added = await controller.addReviewer(reviewer.publicKey());
  assert.equal(added.ok, true);
  assert.equal(added.reAdded, false);
  assert.equal(controller.getState().reviewers.length, 1);
  assert.equal(controller.getState().reviewers[0].wallet, reviewer.publicKey());
  assert.equal(controller.getState().reviewers[0].addedBy, admin.publicKey());
  assert.equal(controller.getState().reviewers[0].revokedAt, null);
  assert.equal(controller.getState().feedback.type, 'success');

  // Create and approve a draft + pending publication intent by this reviewer to verify revocation impact
  const creatorCookie = await f.loginWithKeypair(creator);
  const reviewerCookie = await f.loginWithKeypair(reviewer);
  const draftRes = await f.callRaw('/drafts', {
    method: 'POST',
    cookie: creatorCookie,
    body: {
      question: 'Will Stellar Testnet finalize ledger close within target window?',
      category: 'Crypto',
      tradingClose: 1_764_050_000,
      observationTime: 1_764_050_600,
      resolutionDeadline: 1_764_060_000,
      yesRule: 'Average close time stays under 6 seconds.',
      noRule: 'Average close time is 6 seconds or higher.',
      sources: ['https://horizon-testnet.stellar.org'],
      unavailableDataRule: 'Refund if Horizon data is unavailable for 24 hours.',
    },
  });
  assert.equal(draftRes.status, 201);
  const submitRes = await f.callRaw(`/drafts/${draftRes.body.id}/submit`, {
    method: 'POST',
    cookie: creatorCookie,
    body: {},
  });
  assert.equal(submitRes.status, 200);
  const approveRes = await f.callRaw(`/drafts/${draftRes.body.id}/review`, {
    method: 'POST',
    cookie: reviewerCookie,
    body: {decision: 'approved', expectedRevisionId: draftRes.body.revisionId},
  });
  assert.equal(approveRes.status, 200);
  const intentRes = await f.callRaw(`/drafts/${draftRes.body.id}/publication-intents`, {
    method: 'POST',
    cookie: creatorCookie,
    body: {},
  });
  assert.equal(intentRes.status, 201);
  assert.equal(intentRes.body.intent.status, 'pending');

  // Simulate full page reload: brand new controller reuses matching session cookie without another signature
  const reloadedController = createAdminSettingsController({
    initialAddress: admin.publicKey(),
    signIn: signer.signIn,
  });
  const restored = await reloadedController.restoreSession();
  assert.equal(restored.ok, true);
  assert.equal(signer.getSignInCalls(), 1, 'Reload should reuse valid matching session without re-signing');
  assert.equal(reloadedController.getState().reviewers.length, 1);
  assert.equal(reloadedController.getState().reviewers[0].wallet, reviewer.publicKey());
  assert.equal(reloadedController.getState().reviewers[0].revokedAt, null);

  // Two-step revoke: requestRevoke stages confirmation without mutating backend
  assert.equal(reloadedController.requestRevoke(reviewer.publicKey()), true);
  assert.equal(reloadedController.getState().pendingRevokeWallet, reviewer.publicKey());
  const stillActive = await listAdminReviewers();
  assert.equal(stillActive[0].revokedAt, null);

  // Confirm revoke -> updates backend, refreshes list, reverts approved draft, invalidates pending intent
  f.advanceClock(30);
  const revoked = await reloadedController.confirmRevoke();
  assert.equal(revoked.ok, true);
  assert.equal(reloadedController.getState().pendingRevokeWallet, null);
  assert.equal(reloadedController.getState().feedback.type, 'success');
  const partitionedAfterRevoke = partitionReviewers(reloadedController.getState().reviewers);
  assert.equal(partitionedAfterRevoke.active.length, 0);
  assert.equal(partitionedAfterRevoke.revoked.length, 1);
  assert.ok(partitionedAfterRevoke.revoked[0].revokedAt > 0);

  const draftAfterRevoke = await f.callRaw(`/drafts/${draftRes.body.id}`, {cookie: creatorCookie});
  assert.equal(draftAfterRevoke.body.draft.status, 'draft');
  const intentAfterRevoke = await f.callRaw(`/publication-intents/${intentRes.body.intent.id}`, {cookie: creatorCookie});
  assert.equal(intentAfterRevoke.body.intent.status, 'invalidated');
  assert.equal(intentAfterRevoke.body.intent.invalidatedReason, 'reviewer_revoked');

  // Simulate reload after revoke -> persisted revoked state remains visible
  const afterRevokeReload = createAdminSettingsController({
    initialAddress: admin.publicKey(),
    signIn: signer.signIn,
  });
  assert.equal((await afterRevokeReload.restoreSession()).ok, true);
  assert.equal(partitionReviewers(afterRevokeReload.getState().reviewers).revoked.length, 1);

  // Re-add previously revoked reviewer -> becomes active again and persists across reload
  f.advanceClock(30);
  const reAdded = await afterRevokeReload.addReviewer(reviewer.publicKey());
  assert.equal(reAdded.ok, true);
  assert.equal(reAdded.reAdded, true);
  assert.match(afterRevokeReload.getState().feedback.message, /Re-added reviewer/);
  assert.equal(afterRevokeReload.getState().reviewers[0].revokedAt, null);

  const afterReAddReload = createAdminSettingsController({
    initialAddress: admin.publicKey(),
    signIn: signer.signIn,
  });
  assert.equal((await afterReAddReload.restoreSession()).ok, true);
  const partitionedAfterReAdd = partitionReviewers(afterReAddReload.getState().reviewers);
  assert.equal(partitionedAfterReAdd.active.length, 1);
  assert.equal(partitionedAfterReAdd.revoked.length, 0);
});

test('W28 validation: rejects empty, malformed, contract, and secret-seed addresses before network submission', () => {
  const validKey = Keypair.random();
  assert.equal(validateReviewerWallet('').valid, false);
  assert.equal(validateReviewerWallet('   ').valid, false);
  assert.equal(validateReviewerWallet('not-a-wallet').valid, false);
  assert.equal(validateReviewerWallet(validKey.publicKey().toLowerCase()).valid, false);
  assert.equal(
    validateReviewerWallet('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC').valid,
    false,
  );

  const secretCheck = validateReviewerWallet(validKey.secret());
  assert.equal(secretCheck.valid, false);
  assert.match(secretCheck.error, /secret key/i);

  const validCheck = validateReviewerWallet(`  ${validKey.publicKey()}  `);
  assert.equal(validCheck.valid, true);
  assert.equal(validCheck.wallet, validKey.publicKey());
  assert.equal(validCheck.error, '');
});

test('W28 AC2: ordinary wallets cannot see or use management controls even when a super-admin cookie exists', async t => {
  const admin = Keypair.random();
  const ordinary = Keypair.random();
  const candidate = Keypair.random();
  const f = await apiFixture(t, {superAdminWallets: [admin.publicKey()]});
  const signer = f.createWalletSigner(
    new Map([
      [admin.publicKey(), admin],
      [ordinary.publicKey(), ordinary],
    ]),
  );

  // Super-admin establishes a valid session cookie in the browser
  const controller = createAdminSettingsController({
    initialAddress: admin.publicKey(),
    signIn: signer.signIn,
  });
  assert.equal((await controller.verifySuperAdmin()).ok, true);
  assert.equal((await controller.addReviewer(candidate.publicKey())).ok, true);
  assert.equal(controller.getState().reviewers.length, 1);

  // Switch connected wallet to ordinary user while admin cookie is still present
  controller.setAddress(ordinary.publicKey());
  assert.equal(isAdminAuthorizedForWallet(controller.getState(), ordinary.publicKey()), false);
  assert.equal(controller.getState().status, 'unverified');
  assert.deepEqual(controller.getState().reviewers, []);

  // Silent restore sees /me wallet mismatch and refuses to reuse admin's cookie
  const restoreResult = await controller.restoreSession();
  assert.equal(restoreResult.ok, false);
  assert.equal(restoreResult.reason, 'session_mismatch');
  assert.equal(isAdminAuthorizedForWallet(controller.getState(), ordinary.publicKey()), false);

  // Management actions are blocked for non-authorized wallet
  assert.equal((await controller.addReviewer(Keypair.random().publicKey())).ok, false);
  assert.equal(controller.requestRevoke(candidate.publicKey()), false);

  // Explicit verification signs in as ordinary wallet and receives 403 denied
  const verifyOrdinary = await controller.verifySuperAdmin();
  assert.equal(verifyOrdinary.ok, false);
  assert.equal(controller.getState().status, 'denied');
  assert.match(controller.getState().message, /allowlist/i);
  assert.equal(isAdminAuthorizedForWallet(controller.getState(), ordinary.publicKey()), false);
  assert.deepEqual(controller.getState().reviewers, []);
});

test('W28 AC2: handles duplicate addition (409), already-revoked wallet (404), expired session (401), and API/refresh failures without false success', async t => {
  const admin = Keypair.random();
  const reviewer = Keypair.random();
  const otherReviewer = Keypair.random();
  const f = await apiFixture(t, {superAdminWallets: [admin.publicKey()]});
  const signer = f.createWalletSigner(new Map([[admin.publicKey(), admin]]));

  const controller = createAdminSettingsController({
    initialAddress: admin.publicKey(),
    signIn: signer.signIn,
  });
  assert.equal((await controller.verifySuperAdmin()).ok, true);
  assert.equal((await controller.addReviewer(reviewer.publicKey())).ok, true);

  // 1. Duplicate addition (409)
  const dup = await controller.addReviewer(reviewer.publicKey());
  assert.equal(dup.ok, false);
  assert.equal(controller.getState().feedback.type, 'error');
  assert.match(controller.getState().feedback.message, /already an active reviewer/i);

  // 2. Already-revoked wallet (404): revoke out-of-band, then confirm revoke in UI
  assert.equal(controller.requestRevoke(reviewer.publicKey()), true);
  const outOfBandCookie = await f.loginWithKeypair(admin);
  const outOfBandRevoke = await f.callRaw('/admin/reviewers', {
    method: 'POST',
    cookie: outOfBandCookie,
    body: {wallet: reviewer.publicKey(), action: 'revoke'},
  });
  assert.equal(outOfBandRevoke.status, 200);

  const alreadyRevoked = await controller.confirmRevoke();
  assert.equal(alreadyRevoked.ok, false);
  assert.equal(controller.getState().pendingRevokeWallet, null);
  assert.equal(controller.getState().feedback.type, 'error');
  assert.match(controller.getState().feedback.message, /already been revoked/i);
  // Silent sync updates the list to reflect server's revoked state while keeping error visible
  assert.equal(partitionReviewers(controller.getState().reviewers).revoked.length, 1);

  // 3. API failure on POST does not mutate list or show false success
  const failingPostController = createAdminSettingsController({
    initialAddress: admin.publicKey(),
    signIn: signer.signIn,
    addReviewerApi: async () => {
      const err = new Error('Backend unavailable');
      err.status = 503;
      throw err;
    },
  });
  assert.equal((await failingPostController.verifySuperAdmin()).ok, true);
  const beforeCount = failingPostController.getState().reviewers.length;
  const failedAdd = await failingPostController.addReviewer(otherReviewer.publicKey());
  assert.equal(failedAdd.ok, false);
  assert.equal(failingPostController.getState().feedback.type, 'error');
  assert.match(failingPostController.getState().feedback.message, /Backend unavailable/);
  assert.equal(failingPostController.getState().reviewers.length, beforeCount);

  // 4. Post-mutation refresh failure does not show false success
  let listCalls = 0;
  const failingRefreshController = createAdminSettingsController({
    initialAddress: admin.publicKey(),
    signIn: signer.signIn,
    getReviewers: async options => {
      listCalls += 1;
      if (listCalls > 1) throw new Error('Network interrupted during refresh');
      return await listAdminReviewers(options);
    },
  });
  assert.equal((await failingRefreshController.verifySuperAdmin()).ok, true);
  const refreshFailed = await failingRefreshController.addReviewer(otherReviewer.publicKey());
  assert.equal(refreshFailed.ok, false);
  assert.equal(failingRefreshController.getState().feedback.type, 'error');
  assert.match(failingRefreshController.getState().feedback.message, /refreshing the reviewer list failed/i);

  // 5. Expired session (401) during mutation clears protected state without false success
  f.advanceClock(3700);
  const expiredResult = await controller.addReviewer(Keypair.random().publicKey());
  assert.equal(expiredResult.ok, false);
  assert.equal(controller.getState().status, 'expired');
  assert.equal(isAdminAuthorizedForWallet(controller.getState(), admin.publicKey()), false);
  assert.deepEqual(controller.getState().reviewers, []);
  assert.equal(controller.getState().feedback, null);
  assert.match(controller.getState().message, /session expired/i);
});

test('W28 AC3: in-flight verify, list, add, and revoke requests when switching wallets cannot update the new wallet view', async () => {
  const adminA = Keypair.random();
  const walletB = Keypair.random();
  const reviewer1 = Keypair.random();
  const reviewer2 = Keypair.random();

  // Case 1: in-flight verifySuperAdmin resolves late after switching from adminA to walletB
  const verifyGate = deferred();
  const verifySignals = [];
  const verifyController = createAdminSettingsController({
    initialAddress: adminA.publicKey(),
    getSession: async ({signal}) => {
      verifySignals.push(signal);
      return await verifyGate.promise;
    },
    getNetwork: async () => ({
      role: 'super_admin',
      activeNetwork: 'testnet',
      networks: {testnet: {available: true}, mainnet: {available: false, reason: 'Testnet only'}},
    }),
    getReviewers: async () => [{
      wallet: reviewer1.publicKey(),
      addedBy: adminA.publicKey(),
      addedAt: 1_764_000_000,
      revokedAt: null,
    }],
  });

  const pendingVerify = verifyController.verifySuperAdmin();
  assert.equal(verifyController.getState().verifying, true);

  // Switch wallet mid-flight
  verifyController.setAddress(walletB.publicKey());
  assert.equal(verifySignals[0].aborted, true, 'In-flight request AbortSignal must be aborted on wallet switch');
  assert.equal(verifyController.getState().address, walletB.publicKey());
  assert.equal(verifyController.getState().verifying, false);
  assert.equal(verifyController.getState().status, 'unverified');

  // Late resolution from adminA must not leak into walletB's view
  verifyGate.resolve({wallet: adminA.publicKey()});
  const verifyOutcome = await pendingVerify;
  assert.equal(verifyOutcome.stale, true);
  assert.equal(verifyController.getState().address, walletB.publicKey());
  assert.equal(verifyController.getState().status, 'unverified');
  assert.equal(verifyController.getState().verifiedWallet, null);
  assert.deepEqual(verifyController.getState().reviewers, []);

  // Case 2: in-flight addReviewer and revokeReviewer cannot update walletB after wallet switch
  const addGate = deferred();
  const revokeGate = deferred();
  const mutationSignals = [];
  const mutationController = createAdminSettingsController({
    initialAddress: adminA.publicKey(),
    getSession: async () => ({wallet: adminA.publicKey()}),
    getNetwork: async () => ({
      role: 'super_admin',
      activeNetwork: 'testnet',
      networks: {testnet: {available: true}, mainnet: {available: false, reason: 'Testnet only'}},
    }),
    getReviewers: async () => [{
      wallet: reviewer1.publicKey(),
      addedBy: adminA.publicKey(),
      addedAt: 1_764_000_000,
      revokedAt: null,
    }],
    addReviewerApi: async (_wallet, {signal}) => {
      mutationSignals.push(signal);
      return await addGate.promise;
    },
    revokeReviewerApi: async (_wallet, {signal}) => {
      mutationSignals.push(signal);
      return await revokeGate.promise;
    },
  });

  assert.equal((await mutationController.verifySuperAdmin()).ok, true);
  const pendingAdd = mutationController.addReviewer(reviewer2.publicKey());
  assert.equal(mutationController.getState().mutatingAction, 'add');

  // Switch wallet while addReviewer is in flight
  mutationController.setAddress(walletB.publicKey());
  assert.equal(mutationSignals[0].aborted, true);
  addGate.resolve({updated: true});
  const addOutcome = await pendingAdd;
  assert.equal(addOutcome.stale, true);
  assert.equal(mutationController.getState().address, walletB.publicKey());
  assert.equal(mutationController.getState().status, 'unverified');
  assert.deepEqual(mutationController.getState().reviewers, []);
  assert.equal(mutationController.getState().feedback, null);
  assert.equal(mutationController.getState().mutatingAction, null);

  // Switch back to adminA, start revoke, then switch to walletB before revoke rejects with an error
  mutationController.setAddress(adminA.publicKey());
  assert.equal((await mutationController.verifySuperAdmin()).ok, true);
  assert.equal(mutationController.requestRevoke(reviewer1.publicKey()), true);
  const pendingRevoke = mutationController.confirmRevoke();
  assert.equal(mutationController.getState().mutatingAction, 'revoke');

  mutationController.setAddress(walletB.publicKey());
  assert.equal(mutationSignals[1].aborted, true);
  revokeGate.reject(new Error('Late error from previous wallet'));
  const revokeOutcome = await pendingRevoke;
  assert.equal(revokeOutcome.stale, true);
  assert.equal(mutationController.getState().address, walletB.publicKey());
  assert.equal(mutationController.getState().status, 'unverified');
  assert.equal(mutationController.getState().feedback, null);
  assert.equal(mutationController.getState().message, '');
  assert.equal(mutationController.getState().pendingRevokeWallet, null);
});

test('W28 UI helpers and SettingsPage source wire role-gating, validation, and revocation explanation', async () => {
  assert.equal(formatAuditTimestamp(1_764_000_000), '2025-11-24 16:00 UTC');
  assert.equal(formatAuditTimestamp(null), 'Unknown time');
  assert.ok(REVOCATION_EFFECTS.length >= 3);
  assert.ok(REVOCATION_EFFECTS.some(line => /draft/i.test(line)));
  assert.ok(REVOCATION_EFFECTS.some(line => /publication intent/i.test(line)));

  const settingsSource = await readFile(
    new URL('../frontend/src/components/SettingsPage.jsx', import.meta.url),
    'utf8',
  );
  assert.match(settingsSource, /createAdminSettingsController/);
  assert.match(settingsSource, /isAdminAuthorizedForWallet/);
  assert.match(settingsSource, /validateReviewerWallet/);
  assert.match(settingsSource, /REVOCATION_EFFECTS/);
  assert.match(settingsSource, /Confirm reviewer revocation/);
  assert.match(settingsSource, /Re-add/);
  assert.match(settingsSource, /getAdminNetwork|admin-settings\.mjs/);
  assert.equal(typeof getCurrentSession, 'function');
  assert.equal(typeof getAdminNetwork, 'function');
  assert.equal(typeof addAdminReviewer, 'function');
  assert.equal(typeof revokeAdminReviewer, 'function');
});
