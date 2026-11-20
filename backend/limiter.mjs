import { BlockList, isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_GENERAL_RATE_LIMIT = 120;
export const DEFAULT_AUTH_RATE_LIMIT = 30;
export const DEFAULT_DRAFT_RATE_LIMIT = 60;
export const DEFAULT_AI_RATE_LIMIT = 10;
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const DEFAULT_MAX_RATE_LIMIT_BUCKETS = 1000;

export class RateLimitError extends Error {
  constructor(status, message, { scope, limit, windowSeconds, retryAfterSeconds, resetAt }) {
    super(message);
    this.status = status;
    this.scope = scope;
    this.limit = limit;
    this.windowSeconds = windowSeconds;
    this.retryAfterSeconds = retryAfterSeconds;
    this.resetAt = resetAt;
  }

  toHeaders() {
    return {
      'Retry-After': String(this.retryAfterSeconds),
      'X-RateLimit-Limit': String(this.limit),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(this.resetAt),
      'X-RateLimit-Scope': this.scope,
    };
  }

  toBody() {
    return {
      error: this.message,
      scope: this.scope,
      limit: this.limit,
      windowSeconds: this.windowSeconds,
      retryAfterSeconds: this.retryAfterSeconds,
      resetAt: this.resetAt,
    };
  }
}

export function normalizeIpAddress(raw) {
  if (typeof raw !== 'string') return null;
  let candidate = raw.trim();
  if (!candidate || candidate.length > 128) return null;

  // Handle bracketed IPv6 with optional port: [2001:db8::1]:443 or [::1]
  if (candidate.startsWith('[')) {
    const closeIdx = candidate.indexOf(']');
    if (closeIdx <= 1) return null;
    const hostPart = candidate.slice(1, closeIdx);
    const rest = candidate.slice(closeIdx + 1);
    if (rest !== '') {
      if (!/^:\d{1,5}$/.test(rest)) return null;
      const port = Number(rest.slice(1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    }
    candidate = hostPart;
  } else if (candidate.includes('.') && candidate.split(':').length === 2) {
    // Handle IPv4:port (for example 203.0.113.10:54321) while preserving ::ffff:127.0.0.1
    const [hostPart, portPart] = candidate.split(':');
    if (/^\d{1,5}$/.test(portPart) && isIP(hostPart) === 4) {
      const port = Number(portPart);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
      candidate = hostPart;
    }
  }

  // Strip IPv6 zone identifier if present on link-local sockets (for example fe80::1%lo0)
  const zoneIdx = candidate.indexOf('%');
  if (zoneIdx > 0) {
    candidate = candidate.slice(0, zoneIdx);
  }

  // Unwrap IPv4-mapped IPv6 addresses (::ffff:127.0.0.1 -> 127.0.0.1)
  if (/^::ffff:/i.test(candidate)) {
    const mappedV4 = candidate.slice(7);
    if (isIP(mappedV4) === 4) {
      return mappedV4;
    }
  }

  const family = isIP(candidate);
  if (family === 4) return candidate;
  if (family === 6) return candidate.toLowerCase();
  return null;
}

export function parseTrustedProxiesEnv(rawEnv = '') {
  if (typeof rawEnv !== 'string' || rawEnv.trim() === '') return [];
  return rawEnv.split(',').map(entry => entry.trim()).filter(Boolean);
}

export function buildRateLimitOptionsFromEnv(env = process.env) {
  const optNum = name => {
    const raw = String(env?.[name] ?? '').trim();
    return raw !== '' ? Number(raw) : undefined;
  };
  return {
    rateLimit: optNum('RATE_LIMIT') ?? DEFAULT_GENERAL_RATE_LIMIT,
    authRateLimit: optNum('AUTH_RATE_LIMIT') ?? DEFAULT_AUTH_RATE_LIMIT,
    draftRateLimit: optNum('DRAFT_RATE_LIMIT') ?? DEFAULT_DRAFT_RATE_LIMIT,
    aiRateLimit: optNum('AI_RATE_LIMIT') ?? DEFAULT_AI_RATE_LIMIT,
    rateLimitWindowSeconds: optNum('RATE_LIMIT_WINDOW_SECONDS') ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
    maxRateLimitBuckets: optNum('RATE_LIMIT_MAX_BUCKETS') ?? DEFAULT_MAX_RATE_LIMIT_BUCKETS,
    trustedProxies: parseTrustedProxiesEnv(env?.TRUSTED_PROXIES || ''),
  };
}

export function createTrustedProxyMatcher(trustedProxies = []) {
  const entries = typeof trustedProxies === 'string'
    ? parseTrustedProxiesEnv(trustedProxies)
    : trustedProxies;

  if (!Array.isArray(entries)) {
    throw new Error('TRUSTED_PROXIES must be an array or comma-separated list of IP addresses or CIDR ranges');
  }

  const blockList = new BlockList();
  let count = 0;

  for (const rawEntry of entries) {
    if (typeof rawEntry !== 'string' || rawEntry.trim() === '') {
      throw new Error('TRUSTED_PROXIES must contain valid IP addresses or CIDR ranges');
    }
    const trimmed = rawEntry.trim();
    if (trimmed.includes('/')) {
      const parts = trimmed.split('/');
      if (parts.length !== 2 || !/^\d{1,3}$/.test(parts[1])) {
        throw new Error(`Invalid CIDR entry in TRUSTED_PROXIES: ${trimmed}`);
      }
      const prefixIp = normalizeIpAddress(parts[0]);
      const family = prefixIp ? isIP(prefixIp) : 0;
      const prefixLen = Number(parts[1]);
      const maxPrefix = family === 4 ? 32 : (family === 6 ? 128 : -1);
      if (!prefixIp || prefixLen < 0 || prefixLen > maxPrefix) {
        throw new Error(`Invalid CIDR entry in TRUSTED_PROXIES: ${trimmed}`);
      }
      blockList.addSubnet(prefixIp, prefixLen, family === 4 ? 'ipv4' : 'ipv6');
      count++;
    } else {
      const ip = normalizeIpAddress(trimmed);
      const family = ip ? isIP(ip) : 0;
      if (!ip || family === 0) {
        throw new Error(`Invalid IP address in TRUSTED_PROXIES: ${trimmed}`);
      }
      blockList.addAddress(ip, family === 4 ? 'ipv4' : 'ipv6');
      count++;
    }
  }

  function isTrusted(ip) {
    if (count === 0) return false;
    const normalized = normalizeIpAddress(ip);
    const family = normalized ? isIP(normalized) : 0;
    if (!normalized || family === 0) return false;
    return blockList.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
  }

  return {
    configuredCount: count,
    enabled: count > 0,
    isTrusted,
  };
}

export function resolveClientAddress(req, trustedProxyMatcher) {
  const socketIp = normalizeIpAddress(req?.socket?.remoteAddress || '') || 'unknown';
  if (!trustedProxyMatcher?.enabled || !trustedProxyMatcher.isTrusted(socketIp)) {
    return socketIp;
  }

  const rawXff = req?.headers?.['x-forwarded-for'];
  const xffJoined = Array.isArray(rawXff) ? rawXff.join(',') : (typeof rawXff === 'string' ? rawXff : '');
  if (xffJoined.trim() !== '') {
    const hops = xffJoined.split(',').map(part => part.trim()).filter(Boolean);
    let lastVerifiedHop = socketIp;
    for (let idx = hops.length - 1; idx >= 0; idx--) {
      const hopIp = normalizeIpAddress(hops[idx]);
      if (!hopIp) {
        // Malformed hop encountered: stop walking left and keep the last verified hop.
        return lastVerifiedHop;
      }
      if (!trustedProxyMatcher.isTrusted(hopIp)) {
        return hopIp;
      }
      lastVerifiedHop = hopIp;
    }
    return lastVerifiedHop;
  }

  const rawRealIp = req?.headers?.['x-real-ip'];
  if (typeof rawRealIp === 'string' && rawRealIp.trim() !== '') {
    const realIp = normalizeIpAddress(rawRealIp);
    if (realIp) return realIp;
  }

  return socketIp;
}

export function classifyRouteScope(method, pathname) {
  if (
    method === 'POST' && (pathname === '/api/auth/challenge' || pathname === '/api/auth/verify')
  ) {
    return { kind: 'peer', scope: 'auth' };
  }
  if (method === 'POST' && /^\/api\/drafts\/[^/]+\/ai-assist$/.test(pathname)) {
    return { kind: 'wallet', scope: 'ai' };
  }
  if (
    pathname === '/api/drafts' ||
    pathname.startsWith('/api/drafts/') ||
    pathname === '/api/review-queue' ||
    pathname.startsWith('/api/publication-intents/')
  ) {
    return { kind: 'wallet', scope: 'draft' };
  }
  if (method === 'POST' && pathname === '/api/logout') {
    return { kind: 'session_or_peer', scope: 'anonymous' };
  }
  return { kind: 'peer', scope: 'anonymous' };
}

function validatePositiveInt(value, name, max = 1_000_000) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function createScopedRateLimiter({
  rateLimit = DEFAULT_GENERAL_RATE_LIMIT,
  authRateLimit = undefined,
  draftRateLimit = undefined,
  aiRateLimit = DEFAULT_AI_RATE_LIMIT,
  windowSeconds = DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  maxBuckets = DEFAULT_MAX_RATE_LIMIT_BUCKETS,
  trustedProxies = [],
} = {}) {
  const validatedWindow = validatePositiveInt(windowSeconds, 'RATE_LIMIT_WINDOW_SECONDS', 86_400);
  const validatedMaxBuckets = validatePositiveInt(maxBuckets, 'RATE_LIMIT_MAX_BUCKETS', 100_000);
  const limits = {
    anonymous: validatePositiveInt(rateLimit, 'RATE_LIMIT'),
    auth: validatePositiveInt(authRateLimit ?? rateLimit, 'AUTH_RATE_LIMIT'),
    draft: validatePositiveInt(draftRateLimit ?? rateLimit, 'DRAFT_RATE_LIMIT'),
    ai: validatePositiveInt(aiRateLimit, 'AI_RATE_LIMIT'),
  };

  const proxyMatcher = createTrustedProxyMatcher(trustedProxies);
  const pools = {
    anonymous: new Map(),
    auth: new Map(),
    draft: new Map(),
    ai: new Map(),
  };

  function reclaimPool(pool, time, fullSweep = false) {
    let reclaimed = 0;
    for (const [key, bucket] of pool) {
      if (time - bucket.start >= validatedWindow) {
        pool.delete(key);
        reclaimed++;
      } else if (!fullSweep) {
        break;
      }
    }
    return reclaimed;
  }

  function reclaimExpired(time) {
    let reclaimed = 0;
    for (const pool of Object.values(pools)) {
      reclaimed += reclaimPool(pool, time, true);
    }
    return reclaimed;
  }

  function consume(scope, key, time) {
    const pool = pools[scope];
    const limit = limits[scope];
    if (!pool || !limit) {
      throw new Error(`Unknown rate limit scope: ${scope}`);
    }
    const normalizedKey = String(key || 'unknown');

    // Fast front eviction for insertion-ordered expired buckets
    reclaimPool(pool, time, false);

    let bucket = pool.get(normalizedKey);
    if (bucket && time - bucket.start >= validatedWindow) {
      pool.delete(normalizedKey);
      bucket = undefined;
    }

    if (!bucket) {
      if (pool.size >= validatedMaxBuckets) {
        reclaimPool(pool, time, true);
      }
      if (pool.size >= validatedMaxBuckets) {
        let earliestResetAt = time + validatedWindow;
        for (const active of pool.values()) {
          const candidateReset = active.start + validatedWindow;
          if (candidateReset < earliestResetAt) earliestResetAt = candidateReset;
        }
        const retryAfterSeconds = Math.max(1, earliestResetAt - time);
        throw new RateLimitError(503, 'Try later', {
          scope,
          limit,
          windowSeconds: validatedWindow,
          retryAfterSeconds,
          resetAt: earliestResetAt,
        });
      }
      bucket = { start: time, count: 0 };
      pool.set(normalizedKey, bucket);
    }

    bucket.count += 1;
    const resetAt = bucket.start + validatedWindow;
    const retryAfterSeconds = Math.max(1, resetAt - time);

    if (bucket.count > limit) {
      throw new RateLimitError(429, 'Too many requests', {
        scope,
        limit,
        windowSeconds: validatedWindow,
        retryAfterSeconds,
        resetAt,
      });
    }

    const remaining = Math.max(0, limit - bucket.count);
    return {
      scope,
      limit,
      windowSeconds: validatedWindow,
      remaining,
      resetAt,
      headers: {
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': String(remaining),
        'X-RateLimit-Reset': String(resetAt),
        'X-RateLimit-Scope': scope,
      },
    };
  }

  function checkRequest({ req, method, pathname, resolveWallet, time }) {
    const peerIp = resolveClientAddress(req, proxyMatcher);
    const routeTarget = classifyRouteScope(method, pathname);
    if (routeTarget.kind === 'wallet') {
      const wallet = typeof resolveWallet === 'function' ? resolveWallet(req) : null;
      if (wallet) {
        return consume(routeTarget.scope, wallet, time);
      }
      // Unauthenticated requests against wallet routes consume the peer-scoped anonymous pool
      return consume('anonymous', peerIp, time);
    }
    if (routeTarget.kind === 'session_or_peer') {
      const wallet = typeof resolveWallet === 'function' ? resolveWallet(req) : null;
      if (wallet) {
        return consume('anonymous', `wallet:${wallet}`, time);
      }
      return consume('anonymous', peerIp, time);
    }
    return consume(routeTarget.scope, peerIp, time);
  }

  function stats(time = null) {
    if (typeof time === 'number' && Number.isFinite(time)) {
      reclaimExpired(time);
    }
    return {
      windowSeconds: validatedWindow,
      maxBuckets: validatedMaxBuckets,
      trustedProxiesEnabled: proxyMatcher.enabled,
      trustedProxiesCount: proxyMatcher.configuredCount,
      scopes: {
        anonymous: { limit: limits.anonymous, activeBuckets: pools.anonymous.size },
        auth: { limit: limits.auth, activeBuckets: pools.auth.size },
        draft: { limit: limits.draft, activeBuckets: pools.draft.size },
        ai: { limit: limits.ai, activeBuckets: pools.ai.size },
      },
    };
  }

  return {
    consume,
    checkRequest,
    reclaimExpired,
    resolveClientAddress: req => resolveClientAddress(req, proxyMatcher),
    stats,
  };
}

async function runProxyDrill() {
  const [{ createServer }, { Keypair }, { openStore }, { createApi }] = await Promise.all([
    import('node:http'),
    import('@stellar/stellar-sdk'),
    import('./store.mjs'),
    import('./app.mjs'),
  ]);

  const db = openStore(':memory:');
  const origin = 'http://127.0.0.1:5173';
  let clock = 1_700_000_000;

  const backendServer = createApi({
    db,
    appOrigin: origin,
    now: () => clock,
    rateLimit: 20,
    authRateLimit: 3,
    draftRateLimit: 3,
    aiRateLimit: 1,
    trustedProxies: ['127.0.0.1'],
    getAiSuggestionsFn: async () => ({
      suggestedQuestion: 'Will Stellar protocol 23 pass?',
      suggestedSources: ['stellar.org'],
      ambiguityFlags: [],
      duplicateCandidates: [],
      unresolved: [],
      confidence: 'high',
      model: 'drill-fixture',
      inputHash: 'drill',
    }),
  });
  await new Promise(r => backendServer.listen(0, '127.0.0.1', r));
  const backendPort = backendServer.address().port;

  // Simulated reverse proxy appending real peer client IP onto any untrusted client X-Forwarded-For header
  const proxyServer = createServer(async (clientReq, clientRes) => {
    const simulatedClientIp = clientReq.headers['x-simulated-peer-ip'] || '203.0.113.10';
    const incomingXff = clientReq.headers['x-forwarded-for'];
    const forwardedChain = incomingXff ? `${incomingXff}, ${simulatedClientIp}` : simulatedClientIp;

    const chunks = [];
    for await (const chunk of clientReq) chunks.push(chunk);
    const bodyBuf = Buffer.concat(chunks);

    const forwardHeaders = { ...clientReq.headers, 'x-forwarded-for': forwardedChain };
    delete forwardHeaders.host;
    delete forwardHeaders['x-simulated-peer-ip'];

    const upstream = await fetch(`http://127.0.0.1:${backendPort}${clientReq.url}`, {
      method: clientReq.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(clientReq.method) ? undefined : bodyBuf,
    });
    const text = await upstream.text();
    const outHeaders = {};
    for (const [k, v] of upstream.headers.entries()) {
      outHeaders[k] = v;
    }
    clientRes.writeHead(upstream.status, outHeaders);
    clientRes.end(text);
  });
  await new Promise(r => proxyServer.listen(0, '127.0.0.1', r));
  const proxyBase = `http://127.0.0.1:${proxyServer.address().port}/api`;

  try {
    const alice = Keypair.random();
    const bob = Keypair.random();

    async function proxyLogin(key, peerIp) {
      const chRes = await fetch(`${proxyBase}/auth/challenge`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Simulated-Peer-IP': peerIp },
        body: JSON.stringify({ wallet: key.publicKey() }),
      });
      const ch = await chRes.json();
      const verRes = await fetch(`${proxyBase}/auth/verify`, {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Simulated-Peer-IP': peerIp },
        body: JSON.stringify({ id: ch.id, signature: Buffer.from(key.signMessage(ch.message)).toString('base64') }),
      });
      return verRes.headers.get('set-cookie').split(';')[0];
    }

    const aliceCookie = await proxyLogin(alice, '203.0.113.10');
    const bobCookie = await proxyLogin(bob, '203.0.113.20');

    // Spoofed X-Forwarded-For from 203.0.113.99 cannot bypass 3-request auth limit
    const spoofStatuses = [];
    let spoofRetryAfter = null;
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${proxyBase}/auth/challenge`, {
        method: 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          'X-Simulated-Peer-IP': '203.0.113.99',
          'X-Forwarded-For': `198.51.100.${i + 1}`,
        },
        body: JSON.stringify({ wallet: Keypair.random().publicKey() }),
      });
      spoofStatuses.push(r.status);
      if (r.status === 429) spoofRetryAfter = r.headers.get('retry-after');
    }

    // Signed-in Alice on the same throttled peer IP 203.0.113.99 still creates a draft and runs AI once
    const draftRes = await fetch(`${proxyBase}/drafts`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Simulated-Peer-IP': '203.0.113.99' },
      body: JSON.stringify({ question: 'Will protocol 23 launch on schedule?', tradingClose: 1_800_000_000 }),
    });
    const draft = await draftRes.json();

    const ai1 = await fetch(`${proxyBase}/drafts/${draft.id}/ai-assist`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Simulated-Peer-IP': '203.0.113.99' },
      body: JSON.stringify({}),
    });
    const ai2 = await fetch(`${proxyBase}/drafts/${draft.id}/ai-assist`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: aliceCookie, 'Content-Type': 'application/json', 'X-Simulated-Peer-IP': '203.0.113.99' },
      body: JSON.stringify({}),
    });
    const ai2Body = await ai2.json();

    // Bob's independent wallet still creates drafts even on the same shared proxy IP
    const bobDraft = await fetch(`${proxyBase}/drafts`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: bobCookie, 'Content-Type': 'application/json', 'X-Simulated-Peer-IP': '203.0.113.99' },
      body: JSON.stringify({ question: 'Will XLM daily volume exceed threshold?', tradingClose: 1_800_000_000 }),
    });

    const statsBeforeExpiry = backendServer.rateLimiter.stats(clock);
    clock += 61;
    const statsAfterExpiry = backendServer.rateLimiter.stats(clock);

    console.log(JSON.stringify({
      mode: 'fixture_reverse_proxy_drill',
      spoofedAuthChallengeStatuses: spoofStatuses,
      spoofedAuthRetryAfterHeader: spoofRetryAfter,
      aliceDraftOnThrottledPeerStatus: draftRes.status,
      aliceAiStatuses: [ai1.status, ai2.status],
      aliceAiRateLimitBody: ai2Body,
      bobIndependentDraftStatus: bobDraft.status,
      activeBucketsBeforeWindowExpiry: statsBeforeExpiry.scopes,
      activeBucketsAfterWindowExpiry: statsAfterExpiry.scopes,
    }, null, 2));
  } finally {
    await new Promise(r => { proxyServer.close(r); proxyServer.closeAllConnections(); });
    await new Promise(r => { backendServer.close(r); backendServer.closeAllConnections(); });
    db.close();
  }
}

const isDirectExecution = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectExecution && process.argv.includes('--drill')) {
  runProxyDrill().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
