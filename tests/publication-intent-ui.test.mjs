import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@stellar/stellar-sdk';
import {openStore} from '../backend/store.mjs';
import {createApi} from '../backend/app.mjs';
import {
  FACTORY_CAPABILITY_STATUS,
  compareRulesDigest,
  normalizeIntentView,
  openOrReloadPublicationIntent,
} from '../frontend/src/lib/publication-intent.mjs';

const origin = 'http://127.0.0.1:5173';

async function fixture(t, {superAdminWallets = []} = {}) {
  let time = 1000;
  const db = openStore(':memory:');
  const server = createApi({db, appOrigin: origin, now: () => time, rateLimit: 1000, superAdminWallets});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    db.close();
  });

  async function call(path, {method = 'GET', body, cookie} = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
        ...(cookie ? {Cookie: cookie} : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return {status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null};
  }

  async function login(keypair) {
    const c = await call('/auth/challenge', {method: 'POST', body: {wallet: keypair.publicKey()}});
    assert.equal(c.status, 200);
    const sig = Buffer.from(keypair.signMessage(c.body.message)).toString('base64');
    const v = await call('/auth/verify', {method: 'POST', body: {id: c.body.id, signature: sig}});
    assert.equal(v.status, 200);
    return v.headers.get('set-cookie').split(';')[0];
  }

  function apiFor(cookie) {
    return {
      createPublicationIntentFn: async (draftId, options = {}) => {
        const res = await call(`/drafts/${draftId}/publication-intents`, {method: 'POST', cookie, body: options});
        if (res.status >= 400) {
          const err = new Error(res.body?.error || `HTTP ${res.status}`);
          err.status = res.status;
          err.body = res.body;
          throw err;
        }
        return res.body;
      },
      getPublicationIntentFn: async (intentId) => {
        const res = await call(`/publication-intents/${intentId}`, {cookie});
        if (res.status >= 400) {
          const err = new Error(res.body?.error || `HTTP ${res.status}`);
          err.status = res.status;
          err.body = res.body;
          throw err;
        }
        return res.body;
      },
      listPublicationIntentsFn: async (draftId) => {
        const res = await call(`/drafts/${draftId}/publication-intents`, {cookie});
        if (res.status >= 400) {
          const err = new Error(res.body?.error || `HTTP ${res.status}`);
          err.status = res.status;
          err.body = res.body;
          throw err;
        }
        return res.body;
      },
    };
  }

  return {db, call, login, apiFor, getClock: () => time, setClock: next => { time = next; }};
}

function draftBody(overrides = {}) {
  return {
    question: 'Will BTC reach $100k by end of 2026?',
    category: 'crypto',
    tradingClose: 2000,
    observationTime: 2100,
    resolutionDeadline: 2500,
    yesRule: 'BTC spot > $100k',
    noRule: 'BTC spot <= $100k',
    equalityRule: 'NO wins on equality',
    sources: ['https://api.coinbase.com', 'https://api.kraken.com'],
    fallbackRule: 'Median of active sources',
    unavailableDataRule: 'Invalid after deadline',
    collateral: 'native',
    feeBps: 30,
    policyVersion: 'v1',
    implementationVersion: '1',
    ...overrides,
  };
}

async function setupApprovedDraft(t, {expiry = 5000} = {}) {
  const admin = Keypair.random();
  const creator = Keypair.random();
  const reviewer = Keypair.random();
  const f = await fixture(t, {superAdminWallets: [admin.publicKey()]});
  const ca = await f.login(admin);
  const cc = await f.login(creator);
  const cr = await f.login(reviewer);
  await f.call('/admin/reviewers', {method: 'POST', cookie: ca, body: {wallet: reviewer.publicKey(), action: 'add'}});

  const created = await f.call('/drafts', {
    method: 'POST',
    cookie: cc,
    body: draftBody({resolver: reviewer.publicKey()}),
  });
  assert.equal(created.status, 201);
  const draftId = created.body.id;
  const revisionId = created.body.revisionId;
  const canonicalRulesDigest = created.body.contentHash;

  assert.equal((await f.call(`/drafts/${draftId}/submit`, {method: 'POST', cookie: cc, body: {}})).status, 200);
  const approval = await f.call(`/drafts/${draftId}/review`, {
    method: 'POST',
    cookie: cr,
    body: {decision: 'approved', reason: 'Approved for publication intent', expiry, expectedRevisionId: revisionId},
  });
  assert.equal(approval.status, 200);

  return {f, admin, creator, reviewer, ca, cc, cr, draftId, revisionId, canonicalRulesDigest};
}

test('AC1: opening the same approved revision twice returns the same pending intent and matching terms', async t => {
  const s = await setupApprovedDraft(t);
  const client = s.f.apiFor(s.cc);

  const first = await openOrReloadPublicationIntent({
    draftId: s.draftId,
    revisionId: s.revisionId,
    ...client,
    nowSeconds: s.f.getClock(),
  });
  assert.equal(first.reused, false);
  assert.equal(first.view.status, 'pending');
  assert.equal(first.view.creatorWallet, s.creator.publicKey());
  assert.equal(first.view.reviewerWallet, s.reviewer.publicKey());
  assert.equal(first.view.targetNetwork, 'testnet');
  assert.equal(first.view.approvalExpiry, 5000);

  const second = await openOrReloadPublicationIntent({
    draftId: s.draftId,
    revisionId: s.revisionId,
    ...client,
    nowSeconds: s.f.getClock(),
  });
  assert.equal(second.reused, true);
  assert.equal(second.view.id, first.view.id);
  assert.deepEqual(second.view.terms, first.view.terms);
  assert.equal(second.view.rulesDigest, first.view.rulesDigest);
  assert.equal(second.view.paramsHash, first.view.paramsHash);
});

test('AC1: editing, withdrawing, reviewer revocation, and expiry visibly invalidate or expire the intent', async t => {
  // 1. Editing the draft invalidates the intent
  const sEdit = await setupApprovedDraft(t);
  const clientEdit = sEdit.f.apiFor(sEdit.cc);
  const createdEdit = await openOrReloadPublicationIntent({draftId: sEdit.draftId, ...clientEdit, nowSeconds: sEdit.f.getClock()});
  assert.equal(createdEdit.view.status, 'pending');

  const edited = await sEdit.f.call(`/drafts/${sEdit.draftId}`, {
    method: 'PUT',
    cookie: sEdit.cc,
    body: draftBody({question: 'Edited after approval?', resolver: sEdit.reviewer.publicKey(), expectedRevisionId: sEdit.revisionId}),
  });
  assert.equal(edited.status, 200);

  const reloadedEdit = await openOrReloadPublicationIntent({draftId: sEdit.draftId, ...clientEdit, nowSeconds: sEdit.f.getClock()});
  assert.equal(reloadedEdit.view.status, 'invalidated');
  assert.equal(reloadedEdit.view.invalidatedReason, 'draft_revised');
  assert.match(reloadedEdit.view.statusDetail, /edited after approval/i);

  // 2. Withdrawing the draft invalidates the intent
  const sWithdraw = await setupApprovedDraft(t);
  const clientWithdraw = sWithdraw.f.apiFor(sWithdraw.cc);
  const createdWithdraw = await openOrReloadPublicationIntent({draftId: sWithdraw.draftId, ...clientWithdraw, nowSeconds: sWithdraw.f.getClock()});
  assert.equal(createdWithdraw.view.status, 'pending');

  assert.equal((await sWithdraw.f.call(`/drafts/${sWithdraw.draftId}/withdraw`, {method: 'POST', cookie: sWithdraw.cc, body: {}})).status, 200);
  const reloadedWithdraw = await openOrReloadPublicationIntent({intentId: createdWithdraw.view.id, ...clientWithdraw, nowSeconds: sWithdraw.f.getClock()});
  assert.equal(reloadedWithdraw.view.status, 'invalidated');
  assert.equal(reloadedWithdraw.view.invalidatedReason, 'draft_withdrawn');
  assert.match(reloadedWithdraw.view.statusDetail, /withdrawn/i);

  // 3. Reviewer revocation invalidates the intent
  const sRevoke = await setupApprovedDraft(t);
  const clientRevoke = sRevoke.f.apiFor(sRevoke.cc);
  const createdRevoke = await openOrReloadPublicationIntent({draftId: sRevoke.draftId, ...clientRevoke, nowSeconds: sRevoke.f.getClock()});
  assert.equal(createdRevoke.view.status, 'pending');

  assert.equal((await sRevoke.f.call('/admin/reviewers', {
    method: 'POST',
    cookie: sRevoke.ca,
    body: {wallet: sRevoke.reviewer.publicKey(), action: 'revoke'},
  })).status, 200);
  const reloadedRevoke = await openOrReloadPublicationIntent({intentId: createdRevoke.view.id, ...clientRevoke, nowSeconds: sRevoke.f.getClock()});
  assert.equal(reloadedRevoke.view.status, 'invalidated');
  assert.equal(reloadedRevoke.view.invalidatedReason, 'reviewer_revoked');
  assert.match(reloadedRevoke.view.statusDetail, /reviewer was revoked/i);

  // 4. Approval expiry visibly expires the intent
  const sExpire = await setupApprovedDraft(t, {expiry: 2000});
  const clientExpire = sExpire.f.apiFor(sExpire.cc);
  const createdExpire = await openOrReloadPublicationIntent({draftId: sExpire.draftId, ...clientExpire, nowSeconds: sExpire.f.getClock()});
  assert.equal(createdExpire.view.status, 'pending');

  sExpire.f.setClock(2000);
  const reloadedExpire = await openOrReloadPublicationIntent({intentId: createdExpire.view.id, ...clientExpire, nowSeconds: sExpire.f.getClock()});
  assert.equal(reloadedExpire.view.status, 'expired');
  assert.equal(reloadedExpire.view.invalidatedReason, 'approval_expired');
  assert.match(reloadedExpire.view.statusDetail, /expired/i);
});

test('AC2: pending intent survives reload, links back to revision, and never mints market ID, confirmed tx, or live trading entry', async t => {
  const s = await setupApprovedDraft(t);
  const client = s.f.apiFor(s.cc);

  const opened = await openOrReloadPublicationIntent({
    draftId: s.draftId,
    ...client,
    nowSeconds: s.f.getClock(),
  });

  // Simulate page reload on /publication-intents/:intentId
  const reloaded = await openOrReloadPublicationIntent({
    intentId: opened.view.id,
    ...client,
    nowSeconds: s.f.getClock(),
  });

  assert.equal(reloaded.view.id, opened.view.id);
  assert.equal(reloaded.view.status, 'pending');
  assert.equal(reloaded.view.revisionLink, `/drafts/${s.draftId}/revisions/${s.revisionId}`);
  assert.equal(reloaded.view.confirmedMarket, false);
  assert.equal(reloaded.view.deployed, false);
  assert.equal(reloaded.view.marketId, null);
  assert.equal(reloaded.view.contractAddress, null);
  assert.equal(reloaded.view.txHash, null);
  assert.equal(reloaded.view.inLiveTradingList, false);
});

test('AC3: displayed rules digest matches canonical API fixture and factory boundary / next step is explicit', async t => {
  const s = await setupApprovedDraft(t);
  const client = s.f.apiFor(s.cc);

  const opened = await openOrReloadPublicationIntent({
    draftId: s.draftId,
    ...client,
    nowSeconds: s.f.getClock(),
  });

  const comparison = compareRulesDigest(opened.view.rulesDigest, s.canonicalRulesDigest);
  assert.equal(comparison.matches, true);
  assert.equal(comparison.displayedDigest, s.canonicalRulesDigest);

  // Verify explicit boundary between legacy create flow and reviewed factory deployment
  assert.equal(opened.view.factoryStatus.factoryContract, FACTORY_CAPABILITY_STATUS.factoryContract);
  assert.match(opened.view.factoryStatus.currentCapability, /approve_version/i);
  assert.match(opened.view.factoryStatus.missingCapability, /reviewed-create/i);
  assert.match(opened.view.factoryStatus.legacyBoundary, /legacy/i);
  assert.match(opened.view.factoryStatus.nextStep, /reviewed-create/i);

  // Verify client-side clock expiry check also marks a stale view as expired
  const expiredClientView = normalizeIntentView(opened.intent, {nowSeconds: 5000});
  assert.equal(expiredClientView.status, 'expired');
  assert.equal(expiredClientView.invalidatedReason, 'approval_expired');
});
