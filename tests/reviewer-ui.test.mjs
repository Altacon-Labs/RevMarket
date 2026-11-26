import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {Keypair} from '@stellar/stellar-sdk';
import {openStore} from '../backend/store.mjs';
import {createApi} from '../backend/app.mjs';

const origin = 'http://127.0.0.1:5173';

async function fixture(t, {superAdminWallets = []} = {}) {
  const db = openStore(':memory:');
  let clock = 1000;
  const server = createApi({db, appOrigin: origin, now: () => clock, rateLimit: 1000, superAdminWallets});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, {method = 'GET', body, cookie} = {}) {
    const headers = {Origin: origin};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0] || null,
    };
  }
  async function login(key) {
    const challenge = await call('/auth/challenge', {method: 'POST', body: {wallet: key.publicKey()}});
    const verified = await call('/auth/verify', {
      method: 'POST',
      body: {
        id: challenge.body.id,
        signature: Buffer.from(key.signMessage(challenge.body.message)).toString('base64'),
      },
    });
    return verified.cookie;
  }
  return {call, login, setClock: value => {clock = value;}};
}

function draftBody(overrides = {}) {
  return {
    question: 'Will BTC reach $100k by end of 2026?',
    tradingClose: 2000,
    observationTime: 2060,
    resolutionDeadline: 88400,
    yesRule: 'BTC/USD spot median is strictly above $100,000.',
    noRule: 'BTC/USD spot median is at or below $100,000.',
    sources: ['https://api.coinbase.com/v2/prices/BTC-USD/spot'],
    unavailableDataRule: 'Resolves NO if sources are unavailable.',
    ...overrides,
  };
}

async function scenario(t) {
  const admin = Keypair.random();
  const creator = Keypair.random();
  const reviewer = Keypair.random();
  const f = await fixture(t, {superAdminWallets: [admin.publicKey()]});
  const ca = await f.login(admin);
  const cc = await f.login(creator);
  const cr = await f.login(reviewer);
  assert.equal((await f.call('/admin/reviewers', {
    method: 'POST', cookie: ca, body: {wallet: reviewer.publicKey(), action: 'add'},
  })).status, 200);
  return {f, admin, creator, reviewer, ca, cc, cr};
}

async function submittedDraft(f, cc, overrides = {}) {
  const created = await f.call('/drafts', {method: 'POST', cookie: cc, body: draftBody(overrides)});
  assert.equal(created.status, 201);
  assert.equal((await f.call(`/drafts/${created.body.id}/submit`, {method: 'POST', cookie: cc, body: {}})).status, 200);
  return created.body.id;
}

async function revisionId(f, draftId, cookie) {
  const result = await f.call(`/drafts/${draftId}`, {cookie});
  return result.body.revisions[0].id;
}

test('session role flags separate queue readers from decision rights', async t => {
  const s = await scenario(t);
  const adminMe = await s.f.call('/me', {cookie: s.ca});
  assert.equal(adminMe.body.isSuperAdmin, true);
  assert.equal(adminMe.body.isActiveReviewer, false);
  assert.equal(adminMe.body.canReviewQueue, true);

  const reviewerMe = await s.f.call('/me', {cookie: s.cr});
  assert.equal(reviewerMe.body.isActiveReviewer, true);
  assert.equal(reviewerMe.body.canReviewQueue, true);

  const creatorMe = await s.f.call('/me', {cookie: s.cc});
  assert.equal(creatorMe.body.canReviewQueue, false);
  assert.equal(creatorMe.body.isActiveReviewer, false);
});

test('only authorized roles can read the queue', async t => {
  const s = await scenario(t);
  await submittedDraft(s.f, s.cc);
  assert.equal((await s.f.call('/review-queue', {cookie: s.cr})).status, 200);
  assert.equal((await s.f.call('/review-queue', {cookie: s.ca})).status, 200);
  assert.equal((await s.f.call('/review-queue', {cookie: s.cc})).status, 403);
});

test('exact revision, reason and expiry are stored and visible to the creator after refresh', async t => {
  const s = await scenario(t);
  const draftId = await submittedDraft(s.f, s.cc);
  const expectedRevisionId = await revisionId(s.f, draftId, s.cr);

  const decision = await s.f.call(`/drafts/${draftId}/review`, {
    method: 'POST',
    cookie: s.cr,
    body: {decision: 'approved', reason: 'Rules are unambiguous', expiry: 5000, expectedRevisionId},
  });
  assert.equal(decision.status, 200);
  assert.equal(decision.body.expiry, 5000);

  const creatorView = await s.f.call(`/drafts/${draftId}`, {cookie: s.cc});
  assert.equal(creatorView.body.draft.status, 'approved');
  assert.equal(creatorView.body.reviews[0].decision, 'approved');
  assert.equal(creatorView.body.reviews[0].reason, 'Rules are unambiguous');
  assert.equal(creatorView.body.reviews[0].revisionId, expectedRevisionId);
  assert.equal(creatorView.body.reviews[0].expiry, 5000);
});

test('stale revision, already-decided draft, revoked reviewer and expired session all fail without success', async t => {
  const s = await scenario(t);
  const draftId = await submittedDraft(s.f, s.cc);
  const firstRevision = await revisionId(s.f, draftId, s.cr);

  assert.equal((await s.f.call(`/drafts/${draftId}/review`, {
    method: 'POST', cookie: s.ca, body: {decision: 'approved', expectedRevisionId: firstRevision},
  })).status, 403);
  assert.equal((await s.f.call(`/drafts/${draftId}/review`, {
    method: 'POST', cookie: s.cc, body: {decision: 'approved', expectedRevisionId: firstRevision},
  })).status, 403);

  assert.equal((await s.f.call(`/drafts/${draftId}/review`, {
    method: 'POST', cookie: s.cr, body: {decision: 'changes_requested', reason: 'Add a source', expectedRevisionId: firstRevision},
  })).status, 200);

  const revised = await s.f.call(`/drafts/${draftId}`, {
    method: 'PUT',
    cookie: s.cc,
    body: draftBody({question: 'Will BTC reach $110k?', expectedRevisionId: firstRevision}),
  });
  assert.equal(revised.status, 200);
  assert.equal((await s.f.call(`/drafts/${draftId}/submit`, {method: 'POST', cookie: s.cc, body: {}})).status, 200);

  const stale = await s.f.call(`/drafts/${draftId}/review`, {
    method: 'POST', cookie: s.cr, body: {decision: 'approved', expectedRevisionId: firstRevision},
  });
  assert.equal(stale.status, 409);
  assert.match(stale.body.error, /newer revision/i);

  assert.equal((await s.f.call(`/drafts/${draftId}/review`, {
    method: 'POST', cookie: s.cr, body: {decision: 'rejected', reason: 'No', expectedRevisionId: revised.body.revisionId},
  })).status, 200);
  assert.equal((await s.f.call(`/drafts/${draftId}/review`, {
    method: 'POST', cookie: s.cr, body: {decision: 'approved', expectedRevisionId: revised.body.revisionId},
  })).status, 409);

  const secondDraft = await submittedDraft(s.f, s.cc, {question: 'Second submitted draft'});
  assert.equal((await s.f.call('/admin/reviewers', {
    method: 'POST', cookie: s.ca, body: {wallet: s.reviewer.publicKey(), action: 'revoke'},
  })).status, 200);
  const revoked = await s.f.call(`/drafts/${secondDraft}/review`, {
    method: 'POST', cookie: s.cr, body: {decision: 'approved', expectedRevisionId: await revisionId(s.f, secondDraft, s.ca)},
  });
  assert.equal(revoked.status, 403);

  await s.f.call('/logout', {method: 'POST', cookie: s.cr});
  const expired = await s.f.call(`/drafts/${secondDraft}/review`, {
    method: 'POST', cookie: s.cr, body: {decision: 'approved', expectedRevisionId: 1},
  });
  assert.equal(expired.status, 401);
});

test('reviewer route and exact-revision controls are wired into the app', () => {
  const app = readFileSync(new URL('../frontend/src/App.jsx', import.meta.url), 'utf8');
  const sidebar = readFileSync(new URL('../frontend/src/components/Sidebar.jsx', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../frontend/src/components/ReviewerQueuePage.jsx', import.meta.url), 'utf8');
  const backendLib = readFileSync(new URL('../frontend/src/lib/backend.mjs', import.meta.url), 'utf8');
  const backendApi = readFileSync(new URL('../backend/app.mjs', import.meta.url), 'utf8');
  const activity = readFileSync(new URL('../frontend/src/components/ActivityPage.jsx', import.meta.url), 'utf8');
  const creatorStatus = readFileSync(new URL('../frontend/src/components/CreatorReviewStatus.jsx', import.meta.url), 'utf8');

  assert.match(backendApi, /canReviewQueue:isActiveReviewer\|\|isSuperAdmin/);
  assert.match(app, /path="\/review-queue"/);
  assert.match(app, /canReviewQueue=\{Boolean\(activitySession\?\.canReviewQueue\)\}/);
  assert.match(sidebar, /label: 'Review queue'/);
  assert.match(page, /Inspect saved revision/);
  assert.match(page, /expectedRevisionId: selected\.revision\.id/);
  assert.match(page, /submitReview\(selected\.draft\.id, payload\)/);
  assert.match(page, /decisionErrorFeedback\(err\)/);
  assert.match(page, /const result = await submitReview\(selected\.draft\.id, payload\);[\s\S]*?setSuccess\(/);
  assert.match(page, /catch \(err\) \{\s*setError\(decisionErrorFeedback\(err\)\);\s*\}/);
  assert.match(backendLib, /if \(expiry !== undefined\) body\.expiry = expiry/);
  assert.match(activity, /<CreatorReviewStatus \/>/);
  assert.match(creatorStatus, /Approval expiry:/);
});
