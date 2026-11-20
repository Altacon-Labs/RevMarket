import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, Networks, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { sc } from '../shared/stellar.mjs';
import { openStore } from '../backend/store.mjs';
import { createApi } from '../backend/app.mjs';
import { createMarketEventIngestor } from '../backend/indexer.mjs';
import { encodeVerifiedActivityCursor } from '../backend/verified-activity.mjs';

const ORIGIN = 'http://127.0.0.1:5173';
const VALID_CONTRACT = 'CACP6QFWWZ7BBMDXB5KHC6AAQKE3HBQ4MFFZNNAIJWYK7P6GXJAMLHIN';
const OTHER_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function txHashOf(seed) {
  return String(seed).padStart(64, 'a').slice(0, 64);
}

function makeChainEvent({
  id,
  ledger,
  ledgerClosedAt = '2026-11-19T00:00:05Z',
  txHash = txHashOf(1),
  contractId = VALID_CONTRACT,
  topic,
  value,
}) {
  return {
    type: 'contract',
    id,
    ledger,
    ledgerClosedAt,
    txHash,
    contractId,
    topic,
    value,
  };
}

async function createHttpHarness({ db, getClock, contractId = VALID_CONTRACT, staleAfterSeconds = 120, rateLimit = 1000 }) {
  const server = createApi({
    db,
    appOrigin: ORIGIN,
    now: getClock,
    rateLimit,
    contractId,
    staleAfterSeconds,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;

  async function call(path, { method = 'GET', body, cookie, requestOrigin = ORIGIN, headers = {} } = {}) {
    const h = { ...headers };
    if (requestOrigin) h.Origin = requestOrigin;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (cookie) h.Cookie = cookie;
    const response = await fetch(base + path, {
      method,
      headers: h,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }

  async function login(key) {
    const ch = await call('/auth/challenge', { method: 'POST', body: { wallet: key.publicKey() } });
    assert.equal(ch.status, 200);
    const sig = Buffer.from(key.signMessage(ch.body.message)).toString('base64');
    const ver = await call('/auth/verify', { method: 'POST', body: { id: ch.body.id, signature: sig } });
    assert.equal(ver.status, 200);
    return ver.cookie;
  }

  async function close() {
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }

  return { server, call, login, close };
}

test('verified wallet activity requires authentication and returns only events attributable to the signed-in wallet', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  let clock = 1_700_000_000;

  const alice = Keypair.random();
  const bob = Keypair.random();

  const events = [
    makeChainEvent({
      id: '001000-0001',
      ledger: 1000,
      txHash: txHashOf(10),
      topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(1)],
      value: sc.u64(1_800_000_000n),
    }),
    makeChainEvent({
      id: '001001-0001',
      ledger: 1001,
      txHash: txHashOf(11),
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(1)],
      value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.u32(0), sc.i128(25_000_000n)]),
    }),
    makeChainEvent({
      id: '001001-0002',
      ledger: 1001,
      txHash: txHashOf(12),
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(1)],
      value: xdr.ScVal.scvVec([sc.address(bob.publicKey()), sc.u32(1), sc.i128(40_000_000n)]),
    }),
    makeChainEvent({
      id: '001002-0001',
      ledger: 1002,
      txHash: txHashOf(13),
      topic: [nativeToScVal('settled', { type: 'symbol' }), sc.u32(1)],
      value: xdr.ScVal.scvVec([sc.u32(0), sc.u32(9500)]),
    }),
    makeChainEvent({
      id: '001003-0001',
      ledger: 1003,
      txHash: txHashOf(14),
      topic: [nativeToScVal('claimed', { type: 'symbol' }), sc.u32(1)],
      value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.i128(65_000_000n)]),
    }),
  ];

  const ingestor = createMarketEventIngestor({
    db,
    contractId: VALID_CONTRACT,
    startLedger: 1000,
    now: () => clock,
    rpcClient: {
      async getNetwork() { return { passphrase: Networks.TESTNET, protocolVersion: 30 }; },
      async getEvents(params) {
        if (!params.cursor) return { oldestLedger: 900, latestLedger: 1003, cursor: '001003-0001', events };
        return { oldestLedger: 900, latestLedger: 1003, cursor: '001003-9999', events: [] };
      },
    },
  });
  await ingestor.sync();

  // Also index an event for Alice on a different contract to ensure contract isolation
  const otherIngestor = createMarketEventIngestor({
    db,
    contractId: OTHER_CONTRACT,
    startLedger: 1000,
    now: () => clock,
    rpcClient: {
      async getNetwork() { return { passphrase: Networks.TESTNET, protocolVersion: 30 }; },
      async getEvents(params) {
        if (!params.cursor) {
          return {
            oldestLedger: 900,
            latestLedger: 1004,
            cursor: '001004-0001',
            events: [
              makeChainEvent({
                id: '001004-0001',
                ledger: 1004,
                txHash: txHashOf(99),
                contractId: OTHER_CONTRACT,
                topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(0)],
                value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.u32(0), sc.i128(10_000_000n)]),
              }),
            ],
          };
        }
        return { oldestLedger: 900, latestLedger: 1004, cursor: '001004-9999', events: [] };
      },
    },
  });
  await otherIngestor.sync();

  const h = await createHttpHarness({ db, getClock: () => clock, contractId: VALID_CONTRACT });
  t.after(() => h.close());

  assert.equal((await h.call('/activity/verified')).status, 401);

  const aliceCookie = await h.login(alice);
  const bobCookie = await h.login(bob);

  // Reject attempts to pass a wallet parameter or unknown query keys
  assert.equal((await h.call(`/activity/verified?wallet=${bob.publicKey()}`, { cookie: aliceCookie })).status, 400);

  const aliceVerified = await h.call('/activity/verified', { cookie: aliceCookie });
  assert.equal(aliceVerified.status, 200);
  assert.equal(aliceVerified.body.wallet, alice.publicKey());
  assert.equal(aliceVerified.body.verification, 'confirmed_chain_event');
  assert.deepEqual(aliceVerified.body.verificationSource, {
    source: 'soroban_rpc_indexer',
    authority: 'confirmed_contract_events',
    network: 'testnet',
    networkPassphrase: Networks.TESTNET,
    contractId: VALID_CONTRACT,
    clientReportsIncluded: false,
  });
  assert.deepEqual(
    aliceVerified.body.items.map(item => [item.eventId, item.eventType, item.actorWallet, item.amount, item.verification]),
    [
      ['001003-0001', 'claim', alice.publicKey(), '65000000', 'confirmed_chain_event'],
      ['001001-0001', 'prediction', alice.publicKey(), '25000000', 'confirmed_chain_event'],
    ],
  );

  const bobVerified = await h.call('/activity/verified?eventType=prediction', { cookie: bobCookie });
  assert.equal(bobVerified.status, 200);
  assert.deepEqual(
    bobVerified.body.items.map(item => [item.eventId, item.actorWallet, item.side, item.amount]),
    [['001001-0002', bob.publicKey(), 1, '40000000']],
  );

  await h.call('/logout', { method: 'POST', cookie: aliceCookie });
  assert.equal((await h.call('/activity/verified', { cookie: aliceCookie })).status, 401);

  // When CONTRACT_ID is omitted on a multi-contract SQLite store, fail closed with 503 instead of guessing
  const hUnscoped = await createHttpHarness({ db, getClock: () => clock, contractId: null });
  t.after(() => hUnscoped.close());
  const bobUnscoped = await hUnscoped.call('/activity/verified', { cookie: bobCookie });
  assert.equal(bobUnscoped.status, 503);
  assert.match(bobUnscoped.body.error, /CONTRACT_ID/);
});

test('never upgrades client-reported activity based on supplied txHash and preserves off-chain/on-chain separation', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  let clock = 1_700_000_100;

  const alice = Keypair.random();
  const bob = Keypair.random();

  const createdTxHash = '1'.repeat(64);
  const aliceChainTxHash = '2'.repeat(64);
  const bobChainTxHash = '3'.repeat(64);
  const fakeClientTxHash = '4'.repeat(64);

  const ingestor = createMarketEventIngestor({
    db,
    contractId: VALID_CONTRACT,
    startLedger: 500,
    now: () => clock,
    rpcClient: {
      async getNetwork() { return { passphrase: Networks.TESTNET, protocolVersion: 30 }; },
      async getEvents(params) {
        if (!params.cursor) {
          return {
            oldestLedger: 450,
            latestLedger: 502,
            cursor: '000502-0001',
            events: [
              makeChainEvent({
                id: '000500-0001',
                ledger: 500,
                txHash: createdTxHash,
                topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(9)],
                value: sc.u64(1_900_000_000n),
              }),
              makeChainEvent({
                id: '000501-0001',
                ledger: 501,
                txHash: aliceChainTxHash,
                topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(9)],
                value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.u32(1), sc.i128(90071992547409931n)]),
              }),
              makeChainEvent({
                id: '000502-0001',
                ledger: 502,
                txHash: bobChainTxHash,
                topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(9)],
                value: xdr.ScVal.scvVec([sc.address(bob.publicKey()), sc.u32(0), sc.i128(10_000_000n)]),
              }),
            ],
          };
        }
        return { oldestLedger: 450, latestLedger: 502, cursor: '000502-9999', events: [] };
      },
    },
  });
  await ingestor.sync();

  const h = await createHttpHarness({ db, getClock: () => clock, contractId: VALID_CONTRACT });
  t.after(() => h.close());

  const aliceCookie = await h.login(alice);

  // Alice submits client reports containing:
  // 1) Bob's confirmed txHash
  // 2) The unattributed `created` event txHash
  // 3) An unconfirmed client txHash
  // 4) Alice's own confirmed txHash
  for (const [action, txHash] of [
    ['predict', bobChainTxHash],
    ['create', createdTxHash],
    ['claim', fakeClientTxHash],
    ['predict', aliceChainTxHash],
  ]) {
    const postRes = await h.call('/activity', {
      method: 'POST',
      cookie: aliceCookie,
      body: { wallet: alice.publicKey(), action, txHash },
    });
    assert.equal(postRes.status, 200);
    assert.equal(postRes.body.verification, 'unverified_client_report');
  }

  // Legacy client report endpoint keeps every row strictly unverified_client_report
  const reported = await h.call('/activity', { cookie: aliceCookie });
  assert.equal(reported.status, 200);
  assert.equal(reported.body.items.length, 4);
  for (const row of reported.body.items) {
    assert.equal(row.verification, 'unverified_client_report');
  }

  // Verified endpoint never adopts Bob's hash, unattributed created hash, or unindexed hash
  const verified = await h.call('/activity/verified', { cookie: aliceCookie });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.items.length, 1);
  assert.equal(verified.body.items[0].txHash, aliceChainTxHash);
  assert.equal(verified.body.items[0].amount, '90071992547409931');
  assert.equal(verified.body.items[0].verification, 'confirmed_chain_event');

  // Deleting off-chain profile removes client reports but leaves confirmed chain events intact
  const del = await h.call('/me', { method: 'DELETE', cookie: aliceCookie });
  assert.equal(del.status, 200);
  assert.equal(del.body.onChainDataUnchanged, true);

  const reloginCookie = await h.login(alice);
  assert.equal((await h.call('/activity', { cookie: reloginCookie })).body.items.length, 0);
  assert.equal((await h.call('/activity/verified', { cookie: reloginCookie })).body.items.length, 1);
});

test('cursor pagination stays deterministic across duplicate timestamps, mid-scan inserts and SQLite restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'revmarket-verified-cursor-'));
  const dbFile = join(dir, 'verified.sqlite');
  const alice = Keypair.random();
  const sharedTimestamp = '2026-11-19T06:00:00Z';
  let clock = 1_700_000_500;
  let afterRestart = false;

  const initialEvents = [
    makeChainEvent({
      id: '002001-0001',
      ledger: 2001,
      ledgerClosedAt: '2026-11-19T05:59:00Z',
      txHash: txHashOf(201),
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(1)],
      value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.u32(0), sc.i128(10_000_000n)]),
    }),
    // Three events in ledger 2005 + one in ledger 2006 all sharing the exact same ledgerClosedAt timestamp
    makeChainEvent({
      id: '002005-0001',
      ledger: 2005,
      ledgerClosedAt: sharedTimestamp,
      txHash: txHashOf(202),
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(2)],
      value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.u32(1), sc.i128(20_000_000n)]),
    }),
    makeChainEvent({
      id: '002005-0002',
      ledger: 2005,
      ledgerClosedAt: sharedTimestamp,
      txHash: txHashOf(203),
      topic: [nativeToScVal('claimed', { type: 'symbol' }), sc.u32(1)],
      value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.i128(15_000_000n)]),
    }),
    makeChainEvent({
      id: '002005-0003',
      ledger: 2005,
      ledgerClosedAt: sharedTimestamp,
      txHash: txHashOf(204),
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(3)],
      value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.u32(0), sc.i128(30_000_000n)]),
    }),
    makeChainEvent({
      id: '002006-0001',
      ledger: 2006,
      ledgerClosedAt: sharedTimestamp,
      txHash: txHashOf(205),
      topic: [nativeToScVal('claimed', { type: 'symbol' }), sc.u32(2)],
      value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.i128(45_000_000n)]),
    }),
  ];

  const postRestartEvent = makeChainEvent({
    id: '002008-0001',
    ledger: 2008,
    ledgerClosedAt: '2026-11-19T06:01:00Z',
    txHash: txHashOf(208),
    topic: [nativeToScVal('claimed', { type: 'symbol' }), sc.u32(3)],
    value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.i128(60_000_000n)]),
  });

  const mockRpc = {
    async getNetwork() { return { passphrase: Networks.TESTNET, protocolVersion: 30 }; },
    async getEvents(params) {
      if (!params.cursor) {
        return { oldestLedger: 1950, latestLedger: 2006, cursor: '002006-0001', events: initialEvents };
      }
      if (params.cursor === '002006-0001' && !afterRestart) {
        return { oldestLedger: 1950, latestLedger: 2006, cursor: '002006-9999', events: [] };
      }
      if (params.cursor === '002006-9999' && afterRestart) {
        // Replay boundary event 002006-0001 and append newer event 002008-0001
        return { oldestLedger: 1950, latestLedger: 2008, cursor: '002008-0001', events: [initialEvents[4], postRestartEvent] };
      }
      return { oldestLedger: 1950, latestLedger: 2008, cursor: '002008-9999', events: [] };
    },
  };

  let db = openStore(dbFile);
  let harness = null;
  try {
    const ingestor1 = createMarketEventIngestor({ db, contractId: VALID_CONTRACT, rpcClient: mockRpc, startLedger: 2000, now: () => clock });
    await ingestor1.sync();

    harness = await createHttpHarness({ db, getClock: () => clock, contractId: VALID_CONTRACT });
    const cookie1 = await harness.login(alice);

    const page1 = await harness.call('/activity/verified?limit=2', { cookie: cookie1 });
    assert.equal(page1.status, 200);
    assert.deepEqual(page1.body.items.map(i => i.eventId), ['002006-0001', '002005-0003']);
    assert.equal(page1.body.pageInfo.hasMore, true);
    assert.ok(page1.body.nextCursor);

    // Close HTTP server and SQLite database, reopen, replay boundary + ingest newer event 002008-0001
    await harness.close();
    harness = null;
    db.close();
    db = openStore(dbFile);
    afterRestart = true;
    clock += 10;

    const ingestor2 = createMarketEventIngestor({ db, contractId: VALID_CONTRACT, rpcClient: mockRpc, startLedger: 2000, now: () => clock });
    const sync2 = await ingestor2.sync();
    assert.equal(sync2.insertedCount, 1);
    assert.equal(sync2.duplicateCount, 1);

    harness = await createHttpHarness({ db, getClock: () => clock, contractId: VALID_CONTRACT });
    const cookie2 = await harness.login(alice);

    // Continue paging with the cursor issued before the restart
    const page2 = await harness.call(`/activity/verified?limit=2&cursor=${page1.body.nextCursor}`, { cookie: cookie2 });
    assert.equal(page2.status, 200);
    assert.deepEqual(page2.body.items.map(i => i.eventId), ['002005-0002', '002005-0001']);
    assert.equal(page2.body.pageInfo.hasMore, true);

    const page3 = await harness.call(`/activity/verified?limit=2&cursor=${page2.body.nextCursor}`, { cookie: cookie2 });
    assert.equal(page3.status, 200);
    assert.deepEqual(page3.body.items.map(i => i.eventId), ['002001-0001']);
    assert.equal(page3.body.pageInfo.hasMore, false);
    assert.equal(page3.body.nextCursor, null);

    // Fresh top-of-stream query sees the newly ingested 002008-0001 first
    const headPage = await harness.call('/activity/verified?limit=2', { cookie: cookie2 });
    assert.deepEqual(headPage.body.items.map(i => i.eventId), ['002008-0001', '002006-0001']);

    // Invalid cursors and query parameters fail closed with 400
    const wrongContractCursor = encodeVerifiedActivityCursor({ contractId: OTHER_CONTRACT, ledger: 2005, eventId: '002005-0002' });
    assert.equal((await harness.call(`/activity/verified?cursor=${wrongContractCursor}`, { cookie: cookie2 })).status, 400);
    assert.equal((await harness.call('/activity/verified?cursor=not-valid-json', { cookie: cookie2 })).status, 400);
    assert.equal((await harness.call('/activity/verified?limit=0', { cookie: cookie2 })).status, 400);
    assert.equal((await harness.call('/activity/verified?limit=101', { cookie: cookie2 })).status, 400);
    assert.equal((await harness.call('/activity/verified?eventType=unknown', { cookie: cookie2 })).status, 400);
  } finally {
    if (harness) await harness.close();
    if (db) db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('freshness metadata reports uninitialized state, ledger lag, stale checkpoints and known retention/RPC gaps', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  let clock = 1_700_001_000;
  const alice = Keypair.random();

  // Validate bad startup config rejection first
  assert.throws(() => createApi({ db, appOrigin: ORIGIN, contractId: 'not-a-contract' }), /CONTRACT_ID/);
  assert.throws(() => createApi({ db, appOrigin: ORIGIN, contractId: VALID_CONTRACT, staleAfterSeconds: 0 }), /INDEXER_STALE_AFTER_SECONDS/);

  const h = await createHttpHarness({ db, getClock: () => clock, contractId: VALID_CONTRACT, staleAfterSeconds: 60 });
  t.after(() => h.close());
  const cookie = await h.login(alice);

  // 1. Before indexer ever runs: uninitialized + lagging + incomplete
  const beforeSync = await h.call('/activity/verified', { cookie });
  assert.equal(beforeSync.status, 200);
  assert.equal(beforeSync.body.freshness.status, 'uninitialized');
  assert.equal(beforeSync.body.freshness.complete, false);
  assert.equal(beforeSync.body.freshness.fresh, false);
  assert.equal(beforeSync.body.freshness.lagging, true);
  assert.ok(beforeSync.body.freshness.lagReasons.includes('uninitialized'));

  // 2. Caught-up healthy checkpoint
  let rpcMode = 'caught_up';
  const ingestor = createMarketEventIngestor({
    db,
    contractId: VALID_CONTRACT,
    startLedger: 3000,
    pageLimit: 1,
    now: () => clock,
    rpcClient: {
      async getNetwork() {
        if (rpcMode === 'down') throw new Error('connect ECONNREFUSED');
        return { passphrase: Networks.TESTNET, protocolVersion: 30 };
      },
      async getEvents(params) {
        if (rpcMode === 'expired') {
          const err = new Error('startLedger must be within the ledger range: 4000 - 4500');
          err.code = -32600;
          throw err;
        }
        if (rpcMode === 'behind_tip') {
          return {
            oldestLedger: 2900,
            latestLedger: 3050,
            cursor: '003005-0001',
            events: [
              makeChainEvent({
                id: '003005-0001',
                ledger: 3005,
                txHash: txHashOf(305),
                topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(1)],
                value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.u32(0), sc.i128(5_000_000n)]),
              }),
            ],
          };
        }
        if (!params.cursor) {
          return {
            oldestLedger: 2900,
            latestLedger: 3001,
            cursor: '003001-0001',
            events: [
              makeChainEvent({
                id: '003001-0001',
                ledger: 3001,
                txHash: txHashOf(301),
                topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(1)],
                value: xdr.ScVal.scvVec([sc.address(alice.publicKey()), sc.u32(0), sc.i128(5_000_000n)]),
              }),
            ],
          };
        }
        return { oldestLedger: 2900, latestLedger: 3001, cursor: '003001-9999', events: [] };
      },
    },
  });

  await ingestor.sync();
  const healthy = await h.call('/activity/verified', { cookie });
  assert.equal(healthy.body.freshness.status, 'complete');
  assert.equal(healthy.body.freshness.complete, true);
  assert.equal(healthy.body.freshness.fresh, true);
  assert.equal(healthy.body.freshness.stale, false);
  assert.equal(healthy.body.freshness.lagging, false);
  assert.equal(healthy.body.freshness.ledgerLag, 0);
  assert.deepEqual(healthy.body.freshness.lagReasons, []);

  // 3. Stale checkpoint (clock advances beyond staleAfterSeconds=60)
  clock += 90;
  const stale = await h.call('/activity/verified', { cookie });
  assert.equal(stale.body.freshness.stale, true);
  assert.equal(stale.body.freshness.fresh, false);
  assert.equal(stale.body.freshness.lagging, true);
  assert.equal(stale.body.freshness.ageSeconds, 90);
  assert.ok(stale.body.freshness.lagReasons.includes('checkpoint_stale'));

  // 4. Behind RPC tip (maxPages=1 stops at ledger 3005 while latestRpcLedger is 3050)
  rpcMode = 'behind_tip';
  await ingestor.sync({ maxPages: 1 });
  const behind = await h.call('/activity/verified', { cookie });
  assert.equal(behind.body.freshness.ledgerLag, 45);
  assert.equal(behind.body.freshness.lagging, true);
  assert.equal(behind.body.freshness.fresh, false);
  assert.ok(behind.body.freshness.lagReasons.includes('behind_rpc_tip'));

  // 5. Retention gap recorded -> sticky known_gaps + complete: false
  rpcMode = 'expired';
  await ingestor.sync();
  const gapped = await h.call('/activity/verified', { cookie });
  assert.equal(gapped.body.freshness.status, 'gap');
  assert.equal(gapped.body.freshness.complete, false);
  assert.equal(gapped.body.freshness.hasGaps, true);
  assert.equal(gapped.body.freshness.gapCount, 1);
  assert.equal(gapped.body.freshness.lagging, true);
  assert.ok(gapped.body.freshness.lagReasons.includes('known_gaps'));
  assert.equal(gapped.body.freshness.gaps.length, 1);
  assert.equal(gapped.body.freshness.gaps[0].reason, 'cursor_expired');
  assert.equal(gapped.body.freshness.gaps[0].fromLedger, 3006);
  assert.equal(gapped.body.freshness.gaps[0].toLedger, 3999);
});
