import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair, Networks, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { sc } from '../shared/stellar.mjs';
import { openStore } from './store.mjs';
import { createMarketEventIngestor } from './indexer.mjs';

const DEFAULT_TESTNET_CONTRACT_ID = 'CACP6QFWWZ7BBMDXB5KHC6AAQKE3HBQ4MFFZNNAIJWYK7P6GXJAMLHIN';
const DEFAULT_RPC_URL = 'https://soroban-testnet.stellar.org';

async function runFixtureDrill() {
  const dir = await mkdtemp(join(tmpdir(), 'revmarket-ingest-drill-'));
  const dbPath = join(dir, 'drill.sqlite');
  let db = openStore(dbPath);
  const contractId = DEFAULT_TESTNET_CONTRACT_ID;
  const alice = Keypair.random().publicKey();

  const page1Events = [
    {
      type: 'contract',
      id: '0000001000-0000000001',
      ledger: 1000,
      ledgerClosedAt: '2026-11-19T00:00:00Z',
      txHash: '1'.repeat(64),
      contractId,
      topic: [nativeToScVal('created', { type: 'symbol' }), sc.u32(0)],
      value: sc.u64(1800000000n),
    },
    {
      type: 'contract',
      id: '0000001001-0000000001',
      ledger: 1001,
      ledgerClosedAt: '2026-11-19T00:00:05Z',
      txHash: '2'.repeat(64),
      contractId,
      topic: [nativeToScVal('predict', { type: 'symbol' }), sc.u32(0)],
      value: xdr.ScVal.scvVec([sc.address(alice), sc.u32(0), sc.i128(25000000n)]),
    },
  ];
  const page2Events = [
    {
      type: 'contract',
      id: '0000001002-0000000001',
      ledger: 1002,
      ledgerClosedAt: '2026-11-19T00:01:00Z',
      txHash: '3'.repeat(64),
      contractId,
      topic: [nativeToScVal('settled', { type: 'symbol' }), sc.u32(0)],
      value: xdr.ScVal.scvVec([sc.u32(0), sc.u32(9500)]),
    },
    {
      type: 'contract',
      id: '0000001003-0000000001',
      ledger: 1003,
      ledgerClosedAt: '2026-11-19T00:01:05Z',
      txHash: '4'.repeat(64),
      contractId,
      topic: [nativeToScVal('claimed', { type: 'symbol' }), sc.u32(0)],
      value: xdr.ScVal.scvVec([sc.address(alice), sc.i128(50000000n)]),
    },
  ];

  let expiredMode = false;
  const mockRpc = {
    async getNetwork() {
      return { passphrase: Networks.TESTNET, protocolVersion: 30 };
    },
    async getEvents(params) {
      if (expiredMode) {
        const err = new Error('startLedger must be within the ledger range: 2000 - 2500');
        err.code = -32600;
        throw err;
      }
      if (!params.cursor) {
        return { oldestLedger: 900, latestLedger: 1005, cursor: '0000001001-0000000001', events: page1Events };
      }
      if (params.cursor === '0000001001-0000000001') {
        return { oldestLedger: 900, latestLedger: 1005, cursor: '0000001003-0000000001', events: page2Events };
      }
      return { oldestLedger: 900, latestLedger: 1005, cursor: '0000001005-4294967295', events: [] };
    },
  };

  try {
    const first = createMarketEventIngestor({ db, contractId, rpcClient: mockRpc, startLedger: 1000, pageLimit: 2 });
    const pass1 = await first.sync();
    db.close();

    db = openStore(dbPath);
    const restarted = createMarketEventIngestor({ db, contractId, rpcClient: mockRpc, startLedger: 1000, pageLimit: 2 });
    const pass2 = await restarted.sync();

    expiredMode = true;
    const gapPass = await restarted.sync();

    console.log(JSON.stringify({
      mode: 'fixture',
      contractId,
      initialSync: { status: pass1.status, complete: pass1.complete, insertedCount: pass1.insertedCount, cursor: pass1.checkpoint?.cursor },
      restartSync: { status: pass2.status, complete: pass2.complete, insertedCount: pass2.insertedCount, duplicateCount: pass2.duplicateCount },
      expiredCursorDrill: { status: gapPass.status, complete: gapPass.complete, reason: gapPass.reason, gap: gapPass.gap },
      persistedEvents: restarted.listEvents().length,
    }, null, 2));
  } finally {
    if (db) db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function runLiveIngest() {
  const contractId = (process.env.CONTRACT_ID || DEFAULT_TESTNET_CONTRACT_ID).trim();
  const rpcUrl = (process.env.STELLAR_RPC_URL || DEFAULT_RPC_URL).trim();
  const startLedger = process.env.START_LEDGER ? Number(process.env.START_LEDGER) : undefined;
  const pageLimit = process.env.INGEST_PAGE_LIMIT ? Number(process.env.INGEST_PAGE_LIMIT) : 100;
  const maxPages = process.env.INGEST_MAX_PAGES ? Number(process.env.INGEST_MAX_PAGES) : 25;
  const filename = process.env.BACKEND_DB
    ? resolve(process.env.BACKEND_DB)
    : fileURLToPath(new URL('./data/revmarket.sqlite', import.meta.url));

  await mkdir(dirname(filename), { recursive: true });
  const db = openStore(filename);
  try {
    const ingestor = createMarketEventIngestor({
      db,
      contractId,
      rpcUrl,
      startLedger,
      pageLimit,
      maxPages,
    });
    const result = await ingestor.sync();
    console.log(JSON.stringify({
      mode: 'live_testnet',
      rpcUrl,
      contractId,
      status: result.status,
      complete: result.complete,
      caughtUpToTip: result.caughtUpToTip,
      insertedCount: result.insertedCount,
      duplicateCount: result.duplicateCount,
      excludedCount: result.excludedCount,
      ignoredTopicCount: result.ignoredTopicCount,
      pagesProcessed: result.pagesProcessed,
      checkpoint: result.checkpoint,
      gap: result.gap,
    }, null, 2));
    if (!result.complete && result.status !== 'ok') {
      process.exitCode = 2;
    }
  } finally {
    db.close();
  }
}

if (process.argv.includes('--fixture')) {
  await runFixtureDrill();
} else {
  await runLiveIngest();
}
