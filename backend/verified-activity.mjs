import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, Networks, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';

export const DEFAULT_VERIFIED_ACTIVITY_CONTRACT_ID = 'CACP6QFWWZ7BBMDXB5KHC6AAQKE3HBQ4MFFZNNAIJWYK7P6GXJAMLHIN';
export const DEFAULT_VERIFIED_ACTIVITY_LIMIT = 25;
export const MAX_VERIFIED_ACTIVITY_LIMIT = 100;
export const DEFAULT_STALE_AFTER_SECONDS = 120;

const ALLOWED_QUERY_KEYS = new Set(['limit', 'cursor', 'eventType']);
const ALLOWED_EVENT_TYPES = new Set(['create', 'prediction', 'settlement', 'claim']);

class VerifiedActivityQueryError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validateVerifiedActivityConfig({
  contractId,
  networkPassphrase = Networks.TESTNET,
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
} = {}) {
  if (networkPassphrase !== Networks.TESTNET) {
    throw new Error('Verified activity supports Stellar Testnet only');
  }
  let normalizedContractId = null;
  if (contractId !== undefined && contractId !== null && contractId !== '') {
    if (typeof contractId !== 'string' || !StrKey.isValidContract(contractId)) {
      throw new Error('CONTRACT_ID must be a valid Soroban C-address');
    }
    normalizedContractId = contractId;
  }
  if (!Number.isSafeInteger(staleAfterSeconds) || staleAfterSeconds < 1 || staleAfterSeconds > 86_400) {
    throw new Error('INDEXER_STALE_AFTER_SECONDS must be an integer between 1 and 86400');
  }
  return {
    contractId: normalizedContractId,
    networkPassphrase,
    staleAfterSeconds,
  };
}

export function encodeVerifiedActivityCursor({ contractId, ledger, eventId }) {
  const payload = JSON.stringify({
    v: 1,
    contractId,
    ledger,
    eventId,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeVerifiedActivityCursor(cursor, expectedContractId) {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
    throw new VerifiedActivityQueryError(400, 'Invalid pagination cursor');
  }
  let parsed;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(raw);
  } catch {
    throw new VerifiedActivityQueryError(400, 'Invalid pagination cursor');
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || parsed.v !== 1
    || parsed.contractId !== expectedContractId
    || !Number.isSafeInteger(parsed.ledger)
    || parsed.ledger <= 0
    || typeof parsed.eventId !== 'string'
    || parsed.eventId.length === 0
    || parsed.eventId.length > 128
    || parsed.eventId.trim() !== parsed.eventId
  ) {
    throw new VerifiedActivityQueryError(400, 'Invalid pagination cursor');
  }
  return {
    contractId: parsed.contractId,
    ledger: parsed.ledger,
    eventId: parsed.eventId,
  };
}

function resolveScopedContractId(db, networkPassphrase, configuredContractId) {
  if (configuredContractId) return configuredContractId;
  const scopes = db.prepare(`
    SELECT contract_id AS contractId FROM ingestion_checkpoints WHERE network_passphrase = ?
    UNION
    SELECT contract_id AS contractId FROM market_events WHERE network_passphrase = ?
    LIMIT 2
  `).all(networkPassphrase, networkPassphrase);
  if (scopes.length > 1) {
    throw new VerifiedActivityQueryError(503, 'Multiple indexed contracts found; set CONTRACT_ID on the backend');
  }
  if (scopes.length === 1 && StrKey.isValidContract(scopes[0].contractId)) {
    return scopes[0].contractId;
  }
  return DEFAULT_VERIFIED_ACTIVITY_CONTRACT_ID;
}

function parseQueryParams(searchParams, activeContractId) {
  for (const key of searchParams.keys()) {
    if (!ALLOWED_QUERY_KEYS.has(key)) {
      throw new VerifiedActivityQueryError(400, 'Unexpected query parameters');
    }
  }
  if (
    searchParams.getAll('limit').length > 1
    || searchParams.getAll('cursor').length > 1
    || searchParams.getAll('eventType').length > 1
  ) {
    throw new VerifiedActivityQueryError(400, 'Duplicate query parameters are not allowed');
  }

  let limit = DEFAULT_VERIFIED_ACTIVITY_LIMIT;
  if (searchParams.has('limit')) {
    const rawLimit = searchParams.get('limit') ?? '';
    if (!/^\d+$/.test(rawLimit)) {
      throw new VerifiedActivityQueryError(400, `Limit must be an integer between 1 and ${MAX_VERIFIED_ACTIVITY_LIMIT}`);
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_VERIFIED_ACTIVITY_LIMIT) {
      throw new VerifiedActivityQueryError(400, `Limit must be an integer between 1 and ${MAX_VERIFIED_ACTIVITY_LIMIT}`);
    }
  }

  let eventType = undefined;
  if (searchParams.has('eventType')) {
    const rawType = searchParams.get('eventType') ?? '';
    if (!ALLOWED_EVENT_TYPES.has(rawType)) {
      throw new VerifiedActivityQueryError(400, 'Invalid eventType filter');
    }
    eventType = rawType;
  }

  let cursor = null;
  if (searchParams.has('cursor')) {
    cursor = decodeVerifiedActivityCursor(searchParams.get('cursor'), activeContractId);
  }

  return { limit, eventType, cursor };
}

export function readIndexerFreshness({
  db,
  networkPassphrase = Networks.TESTNET,
  contractId,
  now,
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
  gapLimit = 20,
}) {
  const checkpoint = db.prepare(`
    SELECT
      cursor,
      last_ledger AS lastLedger,
      oldest_rpc_ledger AS oldestRpcLedger,
      latest_rpc_ledger AS latestRpcLedger,
      status,
      has_gaps AS hasGaps,
      gap_count AS gapCount,
      last_error AS lastError,
      updated_at AS updatedAt
    FROM ingestion_checkpoints
    WHERE network_passphrase = ? AND contract_id = ?
  `).get(networkPassphrase, contractId);

  const totalGapRows = db.prepare(`
    SELECT COUNT(*) AS n
    FROM ingestion_gaps
    WHERE network_passphrase = ? AND contract_id = ?
  `).get(networkPassphrase, contractId).n;

  const gaps = db.prepare(`
    SELECT
      id,
      reason,
      from_ledger AS fromLedger,
      to_ledger AS toLedger,
      oldest_rpc_ledger AS oldestRpcLedger,
      latest_rpc_ledger AS latestRpcLedger,
      detail,
      detected_at AS detectedAt
    FROM ingestion_gaps
    WHERE network_passphrase = ? AND contract_id = ?
    ORDER BY id DESC
    LIMIT ?
  `).all(networkPassphrase, contractId, gapLimit);

  if (!checkpoint) {
    const hasGaps = totalGapRows > 0;
    const lagReasons = ['uninitialized'];
    if (hasGaps) lagReasons.push('known_gaps');
    return {
      status: 'uninitialized',
      complete: false,
      fresh: false,
      stale: true,
      lagging: true,
      lagReasons,
      hasGaps,
      gapCount: totalGapRows,
      ageSeconds: null,
      staleAfterSeconds,
      lastLedger: null,
      oldestRpcLedger: null,
      latestRpcLedger: null,
      ledgerLag: null,
      updatedAt: null,
      checkpointCursor: null,
      lastError: null,
      gaps,
    };
  }

  const ageSeconds = Math.max(0, now - checkpoint.updatedAt);
  const stale = ageSeconds > staleAfterSeconds;
  const ledgerLag = checkpoint.latestRpcLedger !== null && checkpoint.lastLedger !== null
    ? Math.max(0, checkpoint.latestRpcLedger - checkpoint.lastLedger)
    : null;
  const gapCount = Math.max(Number(checkpoint.gapCount) || 0, totalGapRows);
  const hasGaps = Boolean(checkpoint.hasGaps) || gapCount > 0;

  const lagReasons = [];
  if (checkpoint.status === 'idle') lagReasons.push('indexer_idle');
  if (checkpoint.status === 'unavailable') lagReasons.push('indexer_unavailable');
  if (hasGaps || checkpoint.status === 'gap') lagReasons.push('known_gaps');
  if (ledgerLag !== null && ledgerLag > 0) lagReasons.push('behind_rpc_tip');
  if (stale) lagReasons.push('checkpoint_stale');

  const complete = checkpoint.status === 'complete' && !hasGaps;
  const lagging = lagReasons.length > 0;
  const fresh = complete && !lagging;

  return {
    status: checkpoint.status,
    complete,
    fresh,
    stale,
    lagging,
    lagReasons,
    hasGaps,
    gapCount,
    ageSeconds,
    staleAfterSeconds,
    lastLedger: checkpoint.lastLedger,
    oldestRpcLedger: checkpoint.oldestRpcLedger,
    latestRpcLedger: checkpoint.latestRpcLedger,
    ledgerLag,
    updatedAt: checkpoint.updatedAt,
    checkpointCursor: checkpoint.cursor,
    lastError: checkpoint.lastError,
    gaps,
  };
}

export function queryVerifiedWalletActivity({
  db,
  wallet,
  searchParams,
  now,
  contractId = undefined,
  networkPassphrase = Networks.TESTNET,
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
}) {
  const activeContractId = resolveScopedContractId(db, networkPassphrase, contractId);
  const { limit, eventType, cursor } = parseQueryParams(searchParams, activeContractId);

  const clauses = [
    'network_passphrase = ?',
    'contract_id = ?',
    'actor_wallet = ?',
  ];
  const params = [networkPassphrase, activeContractId, wallet];

  if (eventType !== undefined) {
    clauses.push('event_type = ?');
    params.push(eventType);
  }
  if (cursor) {
    clauses.push('(ledger < ? OR (ledger = ? AND event_id < ?))');
    params.push(cursor.ledger, cursor.ledger, cursor.eventId);
  }

  params.push(limit + 1);

  const rows = db.prepare(`
    SELECT
      event_id AS eventId,
      tx_hash AS txHash,
      ledger,
      ledger_closed_at AS ledgerClosedAt,
      market_id AS marketId,
      event_type AS eventType,
      raw_topic AS rawTopic,
      actor_wallet AS actorWallet,
      side,
      outcome,
      confidence,
      closes_at AS closesAt,
      amount,
      payload_json AS payloadJson,
      indexed_at AS indexedAt
    FROM market_events
    WHERE ${clauses.join(' AND ')}
    ORDER BY ledger DESC, event_id DESC
    LIMIT ?
  `).all(...params);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
  const nextCursor = hasMore && lastRow
    ? encodeVerifiedActivityCursor({
        contractId: activeContractId,
        ledger: lastRow.ledger,
        eventId: lastRow.eventId,
      })
    : null;

  const items = pageRows.map(row => ({
    eventId: row.eventId,
    txHash: row.txHash,
    ledger: row.ledger,
    ledgerClosedAt: row.ledgerClosedAt,
    marketId: row.marketId,
    eventType: row.eventType,
    rawTopic: row.rawTopic,
    actorWallet: row.actorWallet,
    side: row.side,
    outcome: row.outcome,
    confidence: row.confidence,
    closesAt: row.closesAt,
    amount: row.amount,
    payload: JSON.parse(row.payloadJson),
    indexedAt: row.indexedAt,
    verification: 'confirmed_chain_event',
  }));

  const freshness = readIndexerFreshness({
    db,
    networkPassphrase,
    contractId: activeContractId,
    now,
    staleAfterSeconds,
  });

  return {
    wallet,
    verification: 'confirmed_chain_event',
    verificationSource: {
      source: 'soroban_rpc_indexer',
      authority: 'confirmed_contract_events',
      network: 'testnet',
      networkPassphrase,
      contractId: activeContractId,
      clientReportsIncluded: false,
    },
    items,
    nextCursor,
    pageInfo: {
      limit,
      hasMore,
      nextCursor,
    },
    freshness,
  };
}

async function runFixtureDrill() {
  const [{ openStore }, { createApi }, { createMarketEventIngestor }, { sc }] = await Promise.all([
    import('./store.mjs'),
    import('./app.mjs'),
    import('./indexer.mjs'),
    import('../shared/stellar.mjs'),
  ]);

  const dir = await mkdtemp(join(tmpdir(), 'revmarket-verified-activity-drill-'));
  const dbPath = join(dir, 'drill.sqlite');
  let db = openStore(dbPath);
  const contractId = DEFAULT_VERIFIED_ACTIVITY_CONTRACT_ID;
  const origin = 'http://127.0.0.1:5173';
  const alice = Keypair.random();
  const bob = Keypair.random();
  let clock = 1_700_000_000;

  const events = [
    {
      type: 'contract',
      id: '0000001001-0000000001',
      ledger: 1001,
      ledgerClosedAt: '2026-11-19T00:00:05Z',
      txHash: 'a'.repeat(64),
      contractId,
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(0)],
      value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.u32(0), sc.i128(10_000_000n)]),
    },
    {
      type: 'contract',
      id: '0000001001-0000000002',
      ledger: 1001,
      ledgerClosedAt: '2026-11-19T00:00:05Z',
      txHash: 'b'.repeat(64),
      contractId,
      topic: [nativeToScVal('claimed', { type: 'symbol' }), sc.u32(0)],
      value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.i128(20_000_000n)]),
    },
    {
      type: 'contract',
      id: '0000001001-0000000003',
      ledger: 1001,
      ledgerClosedAt: '2026-11-19T00:00:05Z',
      txHash: 'c'.repeat(64),
      contractId,
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(0)],
      value: xdr.ScVal.scvVec([sc.address(bob.publicKey()), sc.u32(1), sc.i128(15_000_000n)]),
    },
  ];

  const mockRpc = {
    async getNetwork() {
      return { passphrase: Networks.TESTNET, protocolVersion: 30 };
    },
    async getEvents(params) {
      if (!params.cursor) {
        return { oldestLedger: 950, latestLedger: 1001, cursor: '0000001001-0000000003', events };
      }
      return { oldestLedger: 950, latestLedger: 1001, cursor: '0000001001-4294967295', events: [] };
    },
  };

  let server = null;
  try {
    const ingestor = createMarketEventIngestor({ db, contractId, rpcClient: mockRpc, startLedger: 1000, now: () => clock });
    await ingestor.sync();

    server = createApi({ db, appOrigin: origin, now: () => clock, contractId, staleAfterSeconds: 60 });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api`;

    const chRes = await fetch(`${base}/auth/challenge`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: alice.publicKey() }),
    });
    const ch = await chRes.json();
    const sig = Buffer.from(alice.signMessage(ch.message)).toString('base64');
    const verRes = await fetch(`${base}/auth/verify`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ch.id, signature: sig }),
    });
    const cookie = verRes.headers.get('set-cookie').split(';')[0];

    await fetch(`${base}/activity`, {
      method: 'POST',
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: alice.publicKey(), action: 'predict', txHash: 'c'.repeat(64) }),
    });

    const page1 = await (await fetch(`${base}/activity/verified?limit=1`, { headers: { Cookie: cookie } })).json();
    const page2 = await (await fetch(`${base}/activity/verified?limit=1&cursor=${page1.nextCursor}`, { headers: { Cookie: cookie } })).json();
    const reported = await (await fetch(`${base}/activity`, { headers: { Cookie: cookie } })).json();

    clock += 120;
    const staleCheck = await (await fetch(`${base}/activity/verified?limit=1`, { headers: { Cookie: cookie } })).json();

    console.log(JSON.stringify({
      mode: 'fixture',
      contractId,
      wallet: alice.publicKey(),
      page1EventIds: page1.items.map(i => i.eventId),
      page2EventIds: page2.items.map(i => i.eventId),
      reportedActivityVerification: reported.items.map(i => i.verification),
      freshStatus: page1.freshness,
      staleStatus: {
        stale: staleCheck.freshness.stale,
        lagging: staleCheck.freshness.lagging,
        lagReasons: staleCheck.freshness.lagReasons,
      },
    }, null, 2));
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    if (db) db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const isDirectExecution = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectExecution && process.argv.includes('--fixture')) {
  runFixtureDrill().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
