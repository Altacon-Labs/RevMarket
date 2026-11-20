import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Contract, Keypair, Networks, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { sc } from '../shared/stellar.mjs';
import { openStore } from '../backend/store.mjs';
import { createMarketEventIngestor, normalizeMarketEvent } from '../backend/indexer.mjs';

const VALID_CONTRACT = 'CACP6QFWWZ7BBMDXB5KHC6AAQKE3HBQ4MFFZNNAIJWYK7P6GXJAMLHIN';
const OTHER_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function txHashOf(seed) {
  return String(seed).padStart(64, '0').slice(0, 64);
}

function makeContractEvent({
  id,
  ledger,
  txSeed = 1,
  contractId = VALID_CONTRACT,
  useContractObject = false,
  useBase64Xdr = false,
  topic,
  value,
  type = 'contract',
  inSuccessfulContractCall = undefined,
  networkPassphrase = undefined,
}) {
  const encodedTopic = useBase64Xdr ? topic.map(t => t.toXDR('base64')) : topic;
  const encodedValue = useBase64Xdr ? value.toXDR('base64') : value;
  const ev = {
    type,
    id,
    ledger,
    ledgerClosedAt: `2026-11-19T00:${String(ledger % 60).padStart(2, '0')}:00Z`,
    txHash: txHashOf(txSeed),
    contractId: useContractObject ? new Contract(contractId) : contractId,
    topic: encodedTopic,
    value: encodedValue,
  };
  if (inSuccessfulContractCall !== undefined) ev.inSuccessfulContractCall = inSuccessfulContractCall;
  if (networkPassphrase !== undefined) ev.networkPassphrase = networkPassphrase;
  return ev;
}

test('store migration v1/v2 -> v3 preserves existing data and creates indexing tables', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'revmarket-idx-mig-'));
  const file = join(dir, 'mig.sqlite');
  let raw = new DatabaseSync(file);
  const wallet = Keypair.random().publicKey();
  try {
    raw.exec(`
      BEGIN;
      CREATE TABLE users(wallet TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_login INTEGER NOT NULL);
      CREATE TABLE challenges(id TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, wallet TEXT NOT NULL REFERENCES users(wallet) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE activity(id INTEGER PRIMARY KEY, wallet TEXT NOT NULL REFERENCES users(wallet) ON DELETE CASCADE, action TEXT NOT NULL, tx_hash TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(wallet,action,tx_hash));
      PRAGMA user_version=1;
      COMMIT;
    `);
    raw.prepare('INSERT INTO users VALUES(?,?,?)').run(wallet, 100, 100);
    raw.prepare('INSERT INTO activity(wallet,action,tx_hash,created_at) VALUES(?,?,?,?)').run(wallet, 'predict', 'a'.repeat(64), 101);
    raw.close();
    raw = null;

    const db = openStore(file);
    try {
      assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
      assert.equal(db.prepare('SELECT wallet FROM users').get().wallet, wallet);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity').get().n, 1);
      for (const table of ['market_events', 'ingestion_checkpoints', 'ingestion_gaps']) {
        assert.ok(
          db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table),
          `Expected table ${table}`,
        );
      }
    } finally {
      db.close();
    }
  } finally {
    if (raw) raw.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('normalizes create, prediction, settlement and claim events with exact 128-bit integers and case-sensitive addresses', () => {
  const alice = Keypair.random().publicKey();
  const hugeStake = 90071992547409931234567n;
  const hugePayout = 180143985094819862469134n;

  const created = normalizeMarketEvent(
    makeContractEvent({
      id: '0001-0001',
      ledger: 500,
      txSeed: 10,
      useContractObject: true,
      topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(7)],
      value: sc.u64(1799999999n),
    }),
    { contractId: VALID_CONTRACT },
  );
  assert.equal(created.status, 'normalized');
  assert.equal(created.record.eventType, 'create');
  assert.equal(created.record.marketId, 7);
  assert.equal(created.record.closesAt, '1799999999');
  assert.equal(created.record.actorWallet, null);

  const prediction = normalizeMarketEvent(
    makeContractEvent({
      id: '0001-0002',
      ledger: 501,
      txSeed: 11,
      useBase64Xdr: true,
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(7)],
      value: xdr.ScVal.scvVec([sc.address(alice), sc.u32(1), sc.i128(hugeStake)]),
    }),
    { contractId: VALID_CONTRACT },
  );
  assert.equal(prediction.status, 'normalized');
  assert.equal(prediction.record.eventType, 'prediction');
  assert.equal(prediction.record.actorWallet, alice);
  assert.equal(prediction.record.side, 1);
  assert.equal(prediction.record.amount, hugeStake.toString());

  const settled = normalizeMarketEvent(
    makeContractEvent({
      id: '0001-0003',
      ledger: 502,
      txSeed: 12,
      topic: [nativeToScVal('settled', { type: 'symbol' }), sc.u32(7)],
      value: xdr.ScVal.scvVec([sc.u32(1), sc.u32(9250)]),
    }),
    { contractId: VALID_CONTRACT },
  );
  assert.equal(settled.status, 'normalized');
  assert.equal(settled.record.eventType, 'settlement');
  assert.equal(settled.record.outcome, 1);
  assert.equal(settled.record.confidence, 9250);

  const claimed = normalizeMarketEvent(
    makeContractEvent({
      id: '0001-0004',
      ledger: 503,
      txSeed: 13,
      topic: [nativeToScVal('claimed', { type: 'symbol' }), sc.u32(7)],
      value: xdr.ScVal.scvVec([sc.address(alice), sc.i128(hugePayout)]),
    }),
    { contractId: VALID_CONTRACT },
  );
  assert.equal(claimed.status, 'normalized');
  assert.equal(claimed.record.eventType, 'claim');
  assert.equal(claimed.record.actorWallet, alice);
  assert.equal(claimed.record.amount, hugePayout.toString());

  const requestTopic = normalizeMarketEvent(
    makeContractEvent({
      id: '0001-0005',
      ledger: 504,
      txSeed: 14,
      topic: [nativeToScVal('request', { type: 'symbol' }), sc.u32(7)],
      value: sc.u64(1799999999n),
    }),
    { contractId: VALID_CONTRACT },
  );
  assert.equal(requestTopic.status, 'excluded');
  assert.equal(requestTopic.reason, 'ignored_topic');
});

test('replayed pages and database restarts do not duplicate rows or skip events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'revmarket-idx-replay-'));
  const file = join(dir, 'replay.sqlite');
  const alice = Keypair.random().publicKey();
  const bob = Keypair.random().publicKey();

  const ev1 = makeContractEvent({
    id: '001000-0001',
    ledger: 1000,
    txSeed: 21,
    topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(0)],
    value: sc.u64(2000n),
  });
  const ev2 = makeContractEvent({
    id: '001001-0001',
    ledger: 1001,
    txSeed: 22,
    topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(0)],
    value: xdr.ScVal.scvVec([sc.address(alice), sc.u32(0), sc.i128(10000000n)]),
  });
  const ev3 = makeContractEvent({
    id: '001002-0001',
    ledger: 1002,
    txSeed: 23,
    topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(0)],
    value: xdr.ScVal.scvVec([sc.address(bob), sc.u32(1), sc.i128(20000000n)]),
  });
  const ev4 = makeContractEvent({
    id: '001003-0001',
    ledger: 1003,
    txSeed: 24,
    topic: [nativeToScVal('settled', { type: 'symbol' }), sc.u32(0)],
    value: xdr.ScVal.scvVec([sc.u32(0), sc.u32(9000)]),
  });
  const ev5 = makeContractEvent({
    id: '001004-0001',
    ledger: 1004,
    txSeed: 25,
    topic: [nativeToScVal('claimed', { type: 'symbol' }), sc.u32(0)],
    value: xdr.ScVal.scvVec([sc.address(alice), sc.i128(30000000n)]),
  });

  const requests = [];
  let publishClaim = false;
  const mockRpc = {
    async getNetwork() {
      return { passphrase: Networks.TESTNET, protocolVersion: 30 };
    },
    async getEvents(params) {
      requests.push({ ...params });
      if (!params.cursor) {
        return { oldestLedger: 950, latestLedger: 1005, cursor: '001001-0001', events: [ev1, ev2] };
      }
      if (params.cursor === '001001-0001') {
        // Intentionally replay ev2 alongside ev3 and ev4 on overlapping page boundary
        return { oldestLedger: 950, latestLedger: 1005, cursor: '001003-0001', events: [ev2, ev3, ev4] };
      }
      if (params.cursor === '001003-0001') {
        if (publishClaim) {
          // Replay ev4 plus new ev5 after restart
          return { oldestLedger: 950, latestLedger: 1006, cursor: '001004-0001', events: [ev4, ev5] };
        }
        return { oldestLedger: 950, latestLedger: 1005, cursor: '001005-9999', events: [] };
      }
      if (params.cursor === '001005-9999' && publishClaim) {
        return { oldestLedger: 950, latestLedger: 1006, cursor: '001004-0001', events: [ev4, ev5] };
      }
      return { oldestLedger: 950, latestLedger: 1006, cursor: '001006-9999', events: [] };
    },
  };

  let db = openStore(file);
  try {
    const ingestor1 = createMarketEventIngestor({
      db,
      contractId: VALID_CONTRACT,
      rpcClient: mockRpc,
      startLedger: 1000,
      pageLimit: 3,
      now: () => 1700000000,
    });
    const first = await ingestor1.sync();
    assert.equal(first.status, 'ok');
    assert.equal(first.complete, true);
    assert.equal(first.insertedCount, 4);
    assert.equal(first.duplicateCount, 1);
    assert.equal(ingestor1.listEvents().length, 4);
    assert.equal(ingestor1.getCheckpoint().cursor, '001005-9999');

    // Simulate process shutdown and restart from persisted SQLite file
    db.close();
    db = openStore(file);
    publishClaim = true;

    const ingestor2 = createMarketEventIngestor({
      db,
      contractId: VALID_CONTRACT,
      rpcClient: mockRpc,
      startLedger: 1000,
      pageLimit: 3,
      now: () => 1700000010,
    });
    const second = await ingestor2.sync();
    assert.equal(second.status, 'ok');
    assert.equal(second.complete, true);
    assert.equal(second.insertedCount, 1);
    assert.equal(second.duplicateCount, 1);

    // Ensure restarted ingestor resumed from saved cursor rather than startLedger
    const postRestartCall = requests[requests.length - 2];
    assert.equal(postRestartCall.cursor, '001005-9999');
    assert.equal(postRestartCall.startLedger, undefined);

    const allRows = ingestor2.listEvents();
    assert.deepEqual(
      allRows.map(r => [r.eventId, r.eventType, r.marketId]),
      [
        ['001000-0001', 'create', 0],
        ['001001-0001', 'prediction', 0],
        ['001002-0001', 'prediction', 0],
        ['001003-0001', 'settlement', 0],
        ['001004-0001', 'claim', 0],
      ],
    );
  } finally {
    if (db) db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('interrupted mid-page write rolls back partial inserts and checkpoint, then recovers cleanly on retry', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const alice = Keypair.random().publicKey();

  const page1 = [
    makeContractEvent({
      id: '002000-0001',
      ledger: 2000,
      txSeed: 31,
      topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(1)],
      value: sc.u64(3000n),
    }),
    makeContractEvent({
      id: '002001-0001',
      ledger: 2001,
      txSeed: 32,
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(1)],
      value: xdr.ScVal.scvVec([sc.address(alice), sc.u32(0), sc.i128(5000000n)]),
    }),
  ];
  const page2 = [
    makeContractEvent({
      id: '002002-0001',
      ledger: 2002,
      txSeed: 33,
      topic: [nativeToScVal('settled', { type: 'symbol' }), sc.u32(1)],
      value: xdr.ScVal.scvVec([sc.u32(0), sc.u32(10000)]),
    }),
    makeContractEvent({
      id: '002003-0001',
      ledger: 2003,
      txSeed: 34,
      topic: [nativeToScVal('claimed', { type: 'symbol' }), sc.u32(1)],
      value: xdr.ScVal.scvVec([sc.address(alice), sc.i128(5000000n)]),
    }),
  ];

  const mockRpc = {
    async getNetwork() {
      return { passphrase: Networks.TESTNET, protocolVersion: 30 };
    },
    async getEvents(params) {
      if (!params.cursor) {
        return { oldestLedger: 1900, latestLedger: 2005, cursor: '002001-0001', events: page1 };
      }
      if (params.cursor === '002001-0001') {
        return { oldestLedger: 1900, latestLedger: 2005, cursor: '002003-0001', events: page2 };
      }
      return { oldestLedger: 1900, latestLedger: 2005, cursor: '002005-9999', events: [] };
    },
  };

  let failOnPage2 = true;
  const ingestor = createMarketEventIngestor({
    db,
    contractId: VALID_CONTRACT,
    rpcClient: mockRpc,
    startLedger: 2000,
    pageLimit: 2,
    onBeforeCheckpointCommit({ page }) {
      if (failOnPage2 && page === 2) {
        throw new Error('Simulated disk/power interruption before checkpoint commit');
      }
    },
  });

  await assert.rejects(() => ingestor.sync(), /Simulated disk\/power interruption/);

  // Page 1 must remain committed; page 2 inserts and cursor must have rolled back atomically
  assert.equal(ingestor.listEvents().length, 2);
  assert.equal(ingestor.getCheckpoint().cursor, '002001-0001');
  assert.equal(ingestor.getCheckpoint().lastLedger, 2001);

  // Clear fault and retry: resumes from page 1 cursor and commits page 2 with zero duplicates/skips
  failOnPage2 = false;
  const recovered = await ingestor.sync();
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.complete, true);
  assert.equal(recovered.insertedCount, 2);
  assert.equal(recovered.duplicateCount, 0);
  assert.equal(ingestor.listEvents().length, 4);
  assert.equal(ingestor.getCheckpoint().cursor, '002005-9999');
});

test('wrong-network and wrong-contract inputs are strictly excluded at configuration, RPC, and event layers', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());
  const alice = Keypair.random().publicKey();

  assert.throws(
    () => createMarketEventIngestor({ db, contractId: VALID_CONTRACT, networkPassphrase: Networks.PUBLIC, rpcClient: {} }),
    /Testnet only/,
  );
  assert.throws(
    () => createMarketEventIngestor({ db, contractId: alice, rpcClient: {} }),
    /Valid Soroban C-address/,
  );
  assert.throws(
    () => createMarketEventIngestor({ db, contractId: VALID_CONTRACT, rpcUrl: 'http://insecure.example.org' }),
    /HTTPS RPC URL required/,
  );

  // Remote RPC claiming Mainnet is rejected with zero database writes
  const mainnetRpc = {
    async getNetwork() {
      return { passphrase: Networks.PUBLIC, protocolVersion: 30 };
    },
    async getEvents() {
      throw new Error('Should not be called');
    },
  };
  const wrongNetIngestor = createMarketEventIngestor({
    db,
    contractId: VALID_CONTRACT,
    rpcClient: mainnetRpc,
    startLedger: 100,
  });
  await assert.rejects(() => wrongNetIngestor.sync(), /RPC network passphrase mismatch/);
  assert.equal(wrongNetIngestor.getCheckpoint(), null);
  assert.equal(wrongNetIngestor.listEvents().length, 0);

  // Mixed page containing wrong-contract, wrong-network, failed-call, diagnostic, invalid-confidence, and 1 valid event
  const mixedEvents = [
    makeContractEvent({
      id: '003000-0001',
      ledger: 3000,
      txSeed: 41,
      contractId: OTHER_CONTRACT,
      topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(0)],
      value: sc.u64(4000n),
    }),
    makeContractEvent({
      id: '003000-0002',
      ledger: 3000,
      txSeed: 42,
      networkPassphrase: Networks.PUBLIC,
      topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(1)],
      value: sc.u64(4000n),
    }),
    makeContractEvent({
      id: '003000-0003',
      ledger: 3000,
      txSeed: 43,
      type: 'diagnostic',
      topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(2)],
      value: sc.u64(4000n),
    }),
    makeContractEvent({
      id: '003000-0004',
      ledger: 3000,
      txSeed: 44,
      inSuccessfulContractCall: false,
      topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(3)],
      value: sc.u64(4000n),
    }),
    makeContractEvent({
      id: '003000-0005',
      ledger: 3000,
      txSeed: 45,
      topic: [nativeToScVal('settled', { type: 'symbol' }), sc.u32(0)],
      value: xdr.ScVal.scvVec([sc.u32(0), sc.u32(7999)]), // below contract minimum 8000
    }),
    makeContractEvent({
      id: '003000-0006',
      ledger: 3001,
      txSeed: 46,
      useContractObject: true,
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(9)],
      value: xdr.ScVal.scvVec([sc.address(alice), sc.u32(0), sc.i128(12500000n)]),
    }),
  ];

  const mixedRpc = {
    async getNetwork() {
      return { passphrase: Networks.TESTNET, protocolVersion: 30 };
    },
    async getEvents(params) {
      if (!params.cursor) {
        return { oldestLedger: 2900, latestLedger: 3005, cursor: '003001-0006', events: mixedEvents };
      }
      return { oldestLedger: 2900, latestLedger: 3005, cursor: '003005-9999', events: [] };
    },
  };

  const filteredIngestor = createMarketEventIngestor({
    db,
    contractId: VALID_CONTRACT,
    rpcClient: mixedRpc,
    startLedger: 3000,
    pageLimit: 10,
  });
  const res = await filteredIngestor.sync();
  assert.equal(res.status, 'ok');
  assert.equal(res.insertedCount, 1);
  assert.equal(res.excludedCount, 5);
  const kept = filteredIngestor.listEvents();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].eventId, '003000-0006');
  assert.equal(kept[0].actorWallet, alice);
});

test('expired RPC cursor, pruned startLedger, and unavailable RPC report durable gaps instead of completeness', async t => {
  const db = openStore(':memory:');
  t.after(() => db.close());

  const initialEvent = makeContractEvent({
    id: '005000-0001',
    ledger: 5000,
    txSeed: 51,
    topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(0)],
    value: sc.u64(6000n),
  });
  const postGapEvent = makeContractEvent({
    id: '006100-0001',
    ledger: 6100,
    txSeed: 52,
    topic: [nativeToScVal('settled', { type: 'symbol' }), sc.u32(0)],
    value: xdr.ScVal.scvVec([sc.u32(1), sc.u32(8500)]),
  });

  let mode = 'initial';
  const rpcSim = {
    async getNetwork() {
      if (mode === 'net_down') throw new Error('connect ETIMEDOUT 127.0.0.1:443');
      return { passphrase: Networks.TESTNET, protocolVersion: 30 };
    },
    async getEvents(params) {
      if (mode === 'initial') {
        if (!params.cursor) {
          return { oldestLedger: 4900, latestLedger: 5000, cursor: '005000-0001', events: [initialEvent] };
        }
        return { oldestLedger: 4900, latestLedger: 5000, cursor: '005000-9999', events: [] };
      }
      if (mode === 'expired_cursor') {
        // Real Soroban RPC JSON-RPC plain error object shape observed on Testnet
        throw { code: -32600, message: 'startLedger must be within the ledger range: 6000 - 6200' };
      }
      if (mode === 'events_unavailable') {
        throw new Error('HTTP 503 Service Unavailable');
      }
      if (mode === 'recover_after_gap') {
        if (!params.cursor && params.startLedger === 6000) {
          return { oldestLedger: 6000, latestLedger: 6200, cursor: '006100-0001', events: [postGapEvent] };
        }
        return { oldestLedger: 6000, latestLedger: 6200, cursor: '006200-9999', events: [] };
      }
      throw new Error(`Unexpected mode ${mode}`);
    },
  };

  const ingestor = createMarketEventIngestor({
    db,
    contractId: VALID_CONTRACT,
    rpcClient: rpcSim,
    startLedger: 5000,
    pageLimit: 5,
  });

  // 1. Clean initial sync is complete
  const r1 = await ingestor.sync();
  assert.equal(r1.status, 'ok');
  assert.equal(r1.complete, true);
  assert.equal(ingestor.getCheckpoint().complete, true);

  // 2. Expired cursor reports a gap, preserves prior cursor, and NEVER claims completeness
  mode = 'expired_cursor';
  const r2 = await ingestor.sync();
  assert.equal(r2.status, 'gap');
  assert.equal(r2.complete, false);
  assert.equal(r2.reason, 'cursor_expired');
  assert.equal(r2.gap.fromLedger, 5001);
  assert.equal(r2.gap.toLedger, 5999);
  assert.equal(r2.gap.oldestRpcLedger, 6000);
  assert.equal(r2.checkpoint.cursor, '005000-9999');
  assert.equal(r2.checkpoint.complete, false);
  assert.equal(r2.checkpoint.hasGaps, true);

  // 3. Unavailable RPC during getNetwork / getEvents also reports incomplete state
  mode = 'net_down';
  const r3 = await ingestor.sync();
  assert.equal(r3.status, 'unavailable');
  assert.equal(r3.complete, false);
  assert.equal(r3.reason, 'rpc_unavailable');

  // 4. Explicit recovery jump to oldest available ledger ingests new events while retaining sticky gap flag (never falsely claiming completeness)
  mode = 'recover_after_gap';
  const r4 = await ingestor.sync({ recoveryStartLedger: 6000 });
  assert.equal(r4.status, 'gap');
  assert.equal(r4.complete, false);
  assert.equal(r4.insertedCount, 1);
  assert.equal(ingestor.listEvents().length, 2);
  assert.equal(ingestor.getCheckpoint().hasGaps, true);
  assert.equal(ingestor.getCheckpoint().complete, false);
  assert.ok(ingestor.getGaps().length >= 2);

  // 5. Cold start on a separate contract with pruned startLedger also reports start_ledger_pruned gap
  const prunedIngestor = createMarketEventIngestor({
    db,
    contractId: OTHER_CONTRACT,
    rpcClient: {
      async getNetwork() {
        return { passphrase: Networks.TESTNET, protocolVersion: 30 };
      },
      async getEvents() {
        return { oldestLedger: 6000, latestLedger: 6200, cursor: '006200-9999', events: [] };
      },
    },
    startLedger: 1000,
  });
  const r5 = await prunedIngestor.sync();
  assert.equal(r5.status, 'gap');
  assert.equal(r5.complete, false);
  assert.equal(r5.reason, 'start_ledger_pruned');
  assert.equal(r5.gap.fromLedger, 1000);
  assert.equal(r5.gap.toLedger, 5999);
});
