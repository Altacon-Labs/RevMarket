import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Keypair } from '@stellar/stellar-sdk';
import { openStore } from '../backend/store.mjs';
import { createApi } from '../backend/app.mjs';
import { buildRateLimitOptionsFromEnv, classifyRouteScope, createTrustedProxyMatcher, normalizeIpAddress, resolveClientAddress } from '../backend/limiter.mjs';

const ORIGIN = 'http://127.0.0.1:5173';

async function startProxyHarness(t, apiOptions = {}) {
  const db = openStore(':memory:');
  let clock = 1_700_000_000;
  let aiProviderCalls = 0;

  const backendServer = createApi({
    db,
    appOrigin: ORIGIN,
    now: () => clock,
    getAiSuggestionsFn: async () => {
      aiProviderCalls += 1;
      return {
        suggestedQuestion: 'Will Stellar protocol 23 pass?',
        suggestedSources: ['stellar.org'],
        ambiguityFlags: [],
        duplicateCandidates: [],
        unresolved: [],
        confidence: 'high',
        model: 'fixture-model',
        inputHash: 'abc123',
      };
    },
    ...apiOptions,
  });
  await new Promise(resolve => backendServer.listen(0, '127.0.0.1', resolve));
  const backendBase = `http://127.0.0.1:${backendServer.address().port}`;

  const proxyServer = createServer(async (clientReq, clientRes) => {
    const peerIp = clientReq.headers['x-test-peer-ip'] || '203.0.113.10';
    const clientXff = clientReq.headers['x-forwarded-for'];
    const combinedXff = clientXff ? `${clientXff}, ${peerIp}` : peerIp;

    const parts = [];
    for await (const chunk of clientReq) parts.push(chunk);
    const payload = Buffer.concat(parts);

    const upstreamHeaders = { ...clientReq.headers };
    delete upstreamHeaders.host;
    delete upstreamHeaders['x-test-peer-ip'];
    if (peerIp !== 'OMIT_XFF') {
      upstreamHeaders['x-forwarded-for'] = combinedXff;
    }

    const upstream = await fetch(`${backendBase}${clientReq.url}`, {
      method: clientReq.method,
      headers: upstreamHeaders,
      body: ['GET', 'HEAD'].includes(clientReq.method) ? undefined : payload,
    });
    const text = await upstream.text();
    const resHeaders = {};
    for (const [k, v] of upstream.headers.entries()) {
      resHeaders[k] = v;
    }
    clientRes.writeHead(upstream.status, resHeaders);
    clientRes.end(text);
  });
  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  const proxyBase = `http://127.0.0.1:${proxyServer.address().port}`;

  t.after(async () => {
    await new Promise(resolve => { proxyServer.close(resolve); proxyServer.closeAllConnections(); });
    await new Promise(resolve => { backendServer.close(resolve); backendServer.closeAllConnections(); });
    db.close();
  });

  async function callVia(targetBase, path, { method = 'GET', body, cookie, peerIp, headers = {}, requestOrigin = ORIGIN } = {}) {
    const h = { ...headers };
    if (requestOrigin) h.Origin = requestOrigin;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    if (peerIp) h['X-Test-Peer-IP'] = peerIp;
    const response = await fetch(`${targetBase}/api${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }

  async function loginVia(targetBase, key, peerIp) {
    const ch = await callVia(targetBase, '/auth/challenge', {
      method: 'POST',
      peerIp,
      body: { wallet: key.publicKey() },
    });
    assert.equal(ch.status, 200);
    const sig = Buffer.from(key.signMessage(ch.body.message)).toString('base64');
    const ver = await callVia(targetBase, '/auth/verify', {
      method: 'POST',
      peerIp,
      body: { id: ch.body.id, signature: sig },
    });
    assert.equal(ver.status, 200);
    return ver.cookie;
  }

  return {
    db,
    backendServer,
    callDirect: (path, opts) => callVia(backendBase, path, opts),
    callProxy: (path, opts) => callVia(proxyBase, path, opts),
    loginDirect: key => loginVia(backendBase, key),
    loginProxy: (key, peerIp) => loginVia(proxyBase, key, peerIp),
    setClock: v => { clock = v; },
    getClock: () => clock,
    getAiProviderCalls: () => aiProviderCalls,
  };
}

test('untrusted forwarded headers never affect limits when trustedProxies is empty or socket peer is untrusted', async t => {
  const dbCheck = openStore(':memory:');
  try {
    assert.throws(() => createApi({ db: dbCheck, appOrigin: ORIGIN, trustedProxies: ['not-an-ip'] }), /TRUSTED_PROXIES/);
    assert.throws(() => createApi({ db: dbCheck, appOrigin: ORIGIN, trustedProxies: ['10.0.0.0/33'] }), /TRUSTED_PROXIES/);
    assert.throws(() => createApi({ db: dbCheck, appOrigin: ORIGIN, trustedProxies: ['2001:db8::/129'] }), /TRUSTED_PROXIES/);
    assert.throws(() => createApi({ db: dbCheck, appOrigin: ORIGIN, aiRateLimit: 0 }), /AI_RATE_LIMIT/);

    // Setting only RATE_LIMIT in process.env preserves documented AUTH_RATE_LIMIT=30 and DRAFT_RATE_LIMIT=60 defaults
    const envParsed = buildRateLimitOptionsFromEnv({ RATE_LIMIT: '200' });
    const srvEnv = createApi({ db: dbCheck, appOrigin: ORIGIN, ...envParsed });
    assert.deepEqual(srvEnv.rateLimiter.stats().scopes, {
      anonymous: { limit: 200, activeBuckets: 0 },
      auth: { limit: 30, activeBuckets: 0 },
      draft: { limit: 60, activeBuckets: 0 },
      ai: { limit: 10, activeBuckets: 0 },
    });
    assert.deepEqual(classifyRouteScope('GET', '/api/publication-intents/42'), { kind: 'wallet', scope: 'draft' });
  } finally {
    dbCheck.close();
  }

  // Direct socket is 127.0.0.1, which is NOT in 10.10.0.0/16 -> forwarded headers must be ignored
  const h = await startProxyHarness(t, {
    rateLimit: 2,
    authRateLimit: 2,
    trustedProxies: ['10.10.0.0/16'],
  });

  assert.equal((await h.callDirect('/auth/challenge', {
    method: 'POST',
    headers: { 'X-Forwarded-For': '198.51.100.1', 'X-Real-IP': '198.51.100.1' },
    body: { wallet: Keypair.random().publicKey() },
  })).status, 200);

  assert.equal((await h.callDirect('/auth/challenge', {
    method: 'POST',
    headers: { 'X-Forwarded-For': '198.51.100.2', 'X-Real-IP': '198.51.100.2' },
    body: { wallet: Keypair.random().publicKey() },
  })).status, 200);

  const third = await h.callDirect('/auth/challenge', {
    method: 'POST',
    headers: { 'X-Forwarded-For': '198.51.100.3', 'X-Real-IP': '198.51.100.3' },
    body: { wallet: Keypair.random().publicKey() },
  });
  assert.equal(third.status, 429);
  assert.equal(third.body.scope, 'auth');
  assert.equal(third.headers.get('retry-after'), '60');
});

test('trusted reverse proxy resolves right-to-left peer IP across CIDRs/IPv6 and blocks client-prepended X-Forwarded-For spoofing', async t => {
  // Unit-level multi-hop CIDR + IPv4-mapped IPv6 + IPv6 bracket resolution
  const matcher = createTrustedProxyMatcher(['127.0.0.1', '10.0.0.0/8', 'fd00::/8']);
  assert.equal(normalizeIpAddress('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(normalizeIpAddress('[2001:db8::42]:8443'), '2001:db8::42');
  assert.equal(
    resolveClientAddress({
      socket: { remoteAddress: '::ffff:127.0.0.1' },
      headers: { 'x-forwarded-for': '198.51.100.77, 203.0.113.44, 10.2.3.4' },
    }, matcher),
    '203.0.113.44',
  );
  // Malformed hop fails closed to the last verified hop rather than accepting garbage
  assert.equal(
    resolveClientAddress({
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': 'spoofed-token, 10.0.0.9' },
    }, matcher),
    '10.0.0.9',
  );

  // Live two-server HTTP reverse proxy integration test
  const h = await startProxyHarness(t, {
    rateLimit: 10,
    authRateLimit: 2,
    trustedProxies: ['127.0.0.1'],
  });

  // Attacker at 203.0.113.10 rotates spoofed leftmost X-Forwarded-For on every request
  assert.equal((await h.callProxy('/auth/challenge', {
    method: 'POST',
    peerIp: '203.0.113.10',
    headers: { 'X-Forwarded-For': '198.51.100.10' },
    body: { wallet: Keypair.random().publicKey() },
  })).status, 200);

  assert.equal((await h.callProxy('/auth/challenge', {
    method: 'POST',
    peerIp: '203.0.113.10',
    headers: { 'X-Forwarded-For': '198.51.100.11' },
    body: { wallet: Keypair.random().publicKey() },
  })).status, 200);

  const blockedAttacker = await h.callProxy('/auth/challenge', {
    method: 'POST',
    peerIp: '203.0.113.10',
    headers: { 'X-Forwarded-For': '198.51.100.12' },
    body: { wallet: Keypair.random().publicKey() },
  });
  assert.equal(blockedAttacker.status, 429);
  assert.equal(blockedAttacker.body.scope, 'auth');

  // Distinct legitimate peer 203.0.113.20 behind the same proxy succeeds unaffected
  const otherPeer = await h.callProxy('/auth/challenge', {
    method: 'POST',
    peerIp: '203.0.113.20',
    body: { wallet: Keypair.random().publicKey() },
  });
  assert.equal(otherPeer.status, 200);
});

test('wallet draft/AI limits and anonymous limits are independent across multiple accounts behind a proxy and return retry guidance', async t => {
  const h = await startProxyHarness(t, {
    rateLimit: 3,
    authRateLimit: 4,
    draftRateLimit: 2,
    aiRateLimit: 1,
    rateLimitWindowSeconds: 60,
    trustedProxies: ['127.0.0.1'],
  });

  const sharedOfficeIp = '203.0.113.50';
  const alice = Keypair.random();
  const bob = Keypair.random();

  // Sign in both Alice and Bob from the same proxied office IP (uses 4 auth requests total: 2 challenges + 2 verifies)
  const aliceCookie = await h.loginProxy(alice, sharedOfficeIp);
  const bobCookie = await h.loginProxy(bob, sharedOfficeIp);

  // Advance 15 seconds into the window and exhaust anonymous auth + general peer limits on sharedOfficeIp
  h.setClock(1_700_000_015);
  const authBlocked = await h.callProxy('/auth/challenge', {
    method: 'POST',
    peerIp: sharedOfficeIp,
    body: { wallet: Keypair.random().publicKey() },
  });
  assert.equal(authBlocked.status, 429);
  assert.equal(authBlocked.headers.get('retry-after'), '45');
  assert.equal(authBlocked.headers.get('x-ratelimit-scope'), 'auth');
  assert.equal(authBlocked.headers.get('x-ratelimit-remaining'), '0');
  assert.deepEqual(authBlocked.body, {
    error: 'Too many requests',
    scope: 'auth',
    limit: 4,
    windowSeconds: 60,
    retryAfterSeconds: 45,
    resetAt: 1_700_000_060,
  });

  // Also exhaust anonymous general peer limit on sharedOfficeIp (including an unauthenticated /drafts probe)
  assert.equal((await h.callProxy('/health', { peerIp: sharedOfficeIp })).status, 200);
  assert.equal((await h.callProxy('/health', { peerIp: sharedOfficeIp })).status, 200);
  assert.equal((await h.callProxy('/drafts', { peerIp: sharedOfficeIp })).status, 401);
  const anonBlocked = await h.callProxy('/health', { peerIp: sharedOfficeIp });
  assert.equal(anonBlocked.status, 429);
  assert.equal(anonBlocked.body.scope, 'anonymous');

  // Despite both anonymous and auth peer limits being exhausted on sharedOfficeIp,
  // signed-in Alice creates a draft and runs AI assist using her independent wallet buckets
  const aliceDraft1 = await h.callProxy('/drafts', {
    method: 'POST',
    cookie: aliceCookie,
    peerIp: sharedOfficeIp,
    body: { question: 'Will Soroban daily transactions double?', tradingClose: 1_800_000_000 },
  });
  assert.equal(aliceDraft1.status, 201);
  assert.equal(aliceDraft1.headers.get('x-ratelimit-scope'), 'draft');
  assert.equal(aliceDraft1.headers.get('x-ratelimit-remaining'), '1');

  const draftId = aliceDraft1.body.id;
  const aliceAi1 = await h.callProxy(`/drafts/${draftId}/ai-assist`, {
    method: 'POST',
    cookie: aliceCookie,
    peerIp: sharedOfficeIp,
    body: {},
  });
  assert.equal(aliceAi1.status, 200);
  assert.equal(h.getAiProviderCalls(), 1);

  // Alice's second AI call hits aiRateLimit=1 with exact retry guidance and does NOT invoke provider
  h.setClock(1_700_000_025);
  const aliceAi2 = await h.callProxy(`/drafts/${draftId}/ai-assist`, {
    method: 'POST',
    cookie: aliceCookie,
    peerIp: sharedOfficeIp,
    body: {},
  });
  assert.equal(aliceAi2.status, 429);
  assert.equal(aliceAi2.headers.get('retry-after'), '50');
  assert.deepEqual(aliceAi2.body, {
    error: 'Too many requests',
    scope: 'ai',
    limit: 1,
    windowSeconds: 60,
    retryAfterSeconds: 50,
    resetAt: 1_700_000_075,
  });
  assert.equal(h.getAiProviderCalls(), 1);

  // AI throttling preserves manual drafting: Alice still edits her draft using remaining draft quota
  const aliceEdit = await h.callProxy(`/drafts/${draftId}`, {
    method: 'PUT',
    cookie: aliceCookie,
    peerIp: sharedOfficeIp,
    body: {
      question: 'Will Soroban daily transactions double in Q4?',
      tradingClose: 1_800_000_000,
      expectedRevisionId: aliceDraft1.body.revisionId,
    },
  });
  assert.equal(aliceEdit.status, 200);

  // Alice now hits draftRateLimit=2
  const aliceDraftBlocked = await h.callProxy('/drafts', {
    cookie: aliceCookie,
    peerIp: sharedOfficeIp,
  });
  assert.equal(aliceDraftBlocked.status, 429);
  assert.equal(aliceDraftBlocked.body.scope, 'draft');

  // Bob on the exact same sharedOfficeIp still has full independent draft + AI wallet allowances
  const bobDraft = await h.callProxy('/drafts', {
    method: 'POST',
    cookie: bobCookie,
    peerIp: sharedOfficeIp,
    body: { question: 'Will XLM/USD close above threshold?', tradingClose: 1_800_000_000 },
  });
  assert.equal(bobDraft.status, 201);
  const bobAi = await h.callProxy(`/drafts/${bobDraft.body.id}/ai-assist`, {
    method: 'POST',
    cookie: bobCookie,
    peerIp: sharedOfficeIp,
    body: {},
  });
  assert.equal(bobAi.status, 200);
  assert.equal(h.getAiProviderCalls(), 2);

  // Even with sharedOfficeIp's auth + anonymous peer limits AND Alice's draft + AI limits all exhausted,
  // signed-in Alice can still revoke her active session via POST /api/logout
  const aliceLogout = await h.callProxy('/logout', {
    method: 'POST',
    cookie: aliceCookie,
    peerIp: sharedOfficeIp,
  });
  assert.equal(aliceLogout.status, 200);
  assert.equal(aliceLogout.body.signedOut, true);
});

test('bounded limiter enforces maxBuckets with retry guidance and reclaims expired buckets across windows', async t => {
  const h = await startProxyHarness(t, {
    rateLimit: 100,
    authRateLimit: 100,
    draftRateLimit: 2,
    aiRateLimit: 2,
    rateLimitWindowSeconds: 60,
    maxRateLimitBuckets: 3,
    trustedProxies: ['127.0.0.1'],
  });

  const wallets = Array.from({ length: 4 }, () => Keypair.random());
  const cookies = [];
  for (let i = 0; i < wallets.length; i++) {
    // Authenticate all 4 accounts from one shared proxy peer IP (1 auth bucket) so we isolate wallet-bucket saturation
    cookies.push(await h.loginProxy(wallets[i], '203.0.113.100'));
  }

  // Fill all 3 bounded draft wallet buckets at staggered timestamps
  h.setClock(1_700_000_100);
  assert.equal((await h.callProxy('/drafts', { cookie: cookies[0], peerIp: '203.0.113.100' })).status, 200);
  h.setClock(1_700_000_110);
  assert.equal((await h.callProxy('/drafts', { cookie: cookies[1], peerIp: '203.0.113.101' })).status, 200);
  h.setClock(1_700_000_120);
  assert.equal((await h.callProxy('/drafts', { cookie: cookies[2], peerIp: '203.0.113.102' })).status, 200);

  assert.equal(h.backendServer.rateLimiter.stats().scopes.draft.activeBuckets, 3);

  // 4th distinct wallet before W1's bucket expires receives 503 with Retry-After pointing to W1's reset (1700000160)
  h.setClock(1_700_000_125);
  const saturated = await h.callProxy('/drafts', { cookie: cookies[3], peerIp: '203.0.113.103' });
  assert.equal(saturated.status, 503);
  assert.equal(saturated.headers.get('retry-after'), '35');
  assert.equal(saturated.body.scope, 'draft');
  assert.equal(saturated.body.retryAfterSeconds, 35);
  assert.equal(saturated.body.resetAt, 1_700_000_160);

  // Advance clock to 1700000160 -> W1's expired bucket is reclaimed, admitting W4 cleanly
  h.setClock(1_700_000_160);
  const recovered = await h.callProxy('/drafts', { cookie: cookies[3], peerIp: '203.0.113.103' });
  assert.equal(recovered.status, 200);
  assert.equal(h.backendServer.rateLimiter.stats().scopes.draft.activeBuckets, 3);

  // Advance past all windows -> 100% of expired buckets across all scopes are reclaimed
  const afterExpiry = h.backendServer.rateLimiter.stats(1_700_000_300);
  assert.equal(afterExpiry.scopes.anonymous.activeBuckets, 0);
  assert.equal(afterExpiry.scopes.auth.activeBuckets, 0);
  assert.equal(afterExpiry.scopes.draft.activeBuckets, 0);
  assert.equal(afterExpiry.scopes.ai.activeBuckets, 0);
});
