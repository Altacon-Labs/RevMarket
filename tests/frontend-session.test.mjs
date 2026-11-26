import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureActivitySession} from '../frontend/src/lib/backend.mjs';

const walletA = 'G'.padEnd(56, 'A');
const walletB = 'G'.padEnd(56, 'B');

test('a matching backend session is reused without requesting another signature', async () => {
  let signatures = 0;
  const result = await ensureActivitySession(walletA, {
    checkWallet: async wallet => assert.equal(wallet, walletA),
    request: async path => {
      assert.equal(path, '/me');
      return {wallet: walletA};
    },
    signIn: async () => {signatures++;},
  });
  assert.deepEqual(result, {profile: {wallet: walletA}, established: false});
  assert.equal(signatures, 0);
});

test('a different session wallet is replaced and verified for the connected wallet', async () => {
  let requests = 0;
  let signatures = 0;
  const result = await ensureActivitySession(walletB, {
    checkWallet: async wallet => assert.equal(wallet, walletB),
    request: async path => {
      assert.equal(path, '/me');
      requests++;
      return {wallet: requests === 1 ? walletA : walletB};
    },
    signIn: async (wallet, isCurrent) => {
      assert.equal(wallet, walletB);
      assert.equal(isCurrent(), true);
      signatures++;
    },
  });
  assert.deepEqual(result, {profile: {wallet: walletB}, established: true});
  assert.equal(signatures, 1);
  assert.equal(requests, 2);
});

test('a late session response after wallet change is rejected', async () => {
  let current = true;
  await assert.rejects(ensureActivitySession(walletA, {
    checkWallet: async () => {},
    request: async () => {
      current = false;
      return {wallet: walletA};
    },
    isCurrent: () => current,
    signIn: async () => assert.fail('A late response must not start a sign-in'),
  }), /Wallet selection changed/);
});

test('a newly established session must still match /me before it can be used', async () => {
  let requests = 0;
  await assert.rejects(ensureActivitySession(walletB, {
    checkWallet: async () => {},
    request: async () => ({wallet: requests++ === 0 ? walletA : walletA}),
    signIn: async () => {},
  }), /does not match the connected Freighter wallet/);
});

test('session establishment surfaces API outages and rejected signatures without continuing', async () => {
  const unavailable = Object.assign(new Error('Activity service unavailable'), {code: 'API_UNREACHABLE'});
  await assert.rejects(ensureActivitySession(walletA, {
    checkWallet: async () => {},
    request: async () => {throw unavailable;},
    signIn: async () => assert.fail('API outage must not start a signature request'),
  }), error => error === unavailable);

  const unauthorized = Object.assign(new Error('Sign in to activity tracking'), {status: 401});
  const declined = new Error('Activity sign-in signature declined');
  await assert.rejects(ensureActivitySession(walletA, {
    checkWallet: async () => {},
    request: async () => {throw unauthorized;},
    signIn: async () => {throw declined;},
  }), error => error === declined);
});
