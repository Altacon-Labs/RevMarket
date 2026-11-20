import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair, scValToNative} from '@stellar/stellar-sdk';
import {
  MAX_MARKET_ID,
  marketSlug,
  marketPath,
  parseMarketId,
  parseMarketSide,
  loadMarketDetail,
} from '../frontend/src/lib/market-path.mjs';

test('parseMarketId accepts explicit 0 and in-range IDs while rejecting empty, malformed, and out-of-range fragments', () => {
  assert.deepEqual(parseMarketId('#0'), {valid: true, id: 0, reason: null});
  assert.deepEqual(parseMarketId('0'), {valid: true, id: 0, reason: null});
  assert.deepEqual(parseMarketId('#42'), {valid: true, id: 42, reason: null});
  assert.deepEqual(parseMarketId(`#${MAX_MARKET_ID}`), {valid: true, id: MAX_MARKET_ID, reason: null});

  // Empty fragments never select market 0 by accident
  assert.deepEqual(parseMarketId(''), {valid: false, id: null, reason: 'missing'});
  assert.deepEqual(parseMarketId('#'), {valid: false, id: null, reason: 'missing'});

  // Malformed identifiers are rejected
  for (const bad of ['#00', '#01', '#-1', '#1.5', '#abc', '#12a', '# 5', null, undefined]) {
    const res = parseMarketId(bad);
    assert.equal(res.valid, false, `Expected ${bad} to be invalid`);
    assert.equal(res.id, null);
  }

  // Out-of-range identifiers are rejected
  assert.deepEqual(parseMarketId(`#${MAX_MARKET_ID + 1}`), {valid: false, id: null, reason: 'out_of_range'});
  assert.deepEqual(parseMarketId('#50', {maxId: 49}), {valid: false, id: null, reason: 'out_of_range'});
});

test('parseMarketSide preserves selected side from query string', () => {
  assert.equal(parseMarketSide('?side=1'), 1);
  assert.equal(parseMarketSide('?side=0'), 0);
  assert.equal(parseMarketSide(''), 0);
  assert.equal(parseMarketSide('?side=2'), 0);

  const link = marketPath({id: 7, question: 'Will XLM exceed $1?'}, 1);
  assert.equal(link, '/event/will-xlm-exceed-1?side=1#7');
  assert.equal(marketSlug('Will XLM exceed $1?'), 'will-xlm-exceed-1');
});

test('loadMarketDetail fetches an older market missing from the latest 50 list and loads only the active wallet position', async () => {
  const wallet = Keypair.random().publicKey();
  const calls = [];
  const client = {
    async read(source, method, args) {
      calls.push({source, method, args: args.map(scValToNative)});
      if (method === 'get_market') {
        return {
          question: 'Older market #3 outside latest 50',
          kind: ['Event'],
          closes_at: 2000n,
          deadline: 88400n,
          status: 0,
          yes_pool: 50000000n,
          no_pool: 25000000n,
          outcome: 0,
          confidence: 0,
          evidence: new Uint8Array(32),
        };
      }
      if (method === 'get_position') {
        return {amount: 10000000n, side: 1, claimed: false};
      }
      throw new Error(`Unexpected method ${method}`);
    },
  };

  // Loaded list only has markets 50..99
  const loadedMarkets = Array.from({length: 50}, (_, i) => ({
    id: 50 + i,
    question: `Loaded market #${50 + i}`,
    kind: 'Event',
  }));

  const result = await loadMarketDetail({
    hash: '#3',
    markets: loadedMarkets,
    positions: {},
    client,
    source: wallet,
    address: wallet,
  });

  assert.equal(result.status, 'ready');
  assert.equal(result.committed, true);
  assert.equal(result.market.id, 3);
  assert.equal(result.market.question, 'Older market #3 outside latest 50');
  assert.equal(result.market.kind, 'Event');
  assert.deepEqual(result.position, {amount: 10000000n, side: 1, claimed: false});
  assert.deepEqual(
    calls.map(c => c.method),
    ['get_market', 'get_position']
  );
  assert.equal(calls[0].args[0], 3);
  assert.equal(calls[1].args[0], 3);
  assert.equal(calls[1].args[1], wallet);
});

test('loadMarketDetail distinguishes missing market from RPC failure and never falls through to another market', async () => {
  const loadedMarkets = [{id: 0, question: 'Market Zero', kind: 'Event'}];

  // Empty hash must not fall back to Market Zero
  const emptyRes = await loadMarketDetail({hash: '', markets: loadedMarkets});
  assert.equal(emptyRes.status, 'missing');
  assert.equal(emptyRes.market, null);

  // Contract Missing error (#1) yields status: 'missing'
  const missingClient = {
    async read() {
      throw new Error('Read get_market failed: HostError: Error(Contract, #1)');
    },
  };
  const missingRes = await loadMarketDetail({
    hash: '#12',
    markets: loadedMarkets,
    client: missingClient,
    source: 'G_READ_SOURCE',
  });
  assert.equal(missingRes.status, 'missing');
  assert.equal(missingRes.reason, 'not_found');
  assert.equal(missingRes.market, null);

  // Transport/RPC failure yields status: 'error'
  const brokenClient = {
    async read() {
      throw new Error('Soroban RPC 503 Service Unavailable');
    },
  };
  const rpcErrRes = await loadMarketDetail({
    hash: '#12',
    markets: loadedMarkets,
    client: brokenClient,
    source: 'G_READ_SOURCE',
  });
  assert.equal(rpcErrRes.status, 'error');
  assert.equal(rpcErrRes.reason, 'rpc_error');
  assert.match(rpcErrRes.error, /503 Service Unavailable/);
});

test('late response after route or wallet change is marked uncommitted and cannot overwrite current state', async () => {
  const walletA = Keypair.random().publicKey();
  const walletB = Keypair.random().publicKey();
  let activeRoute = '#4';
  let activeWallet = walletA;

  const slowClient = {
    async read(source, method) {
      if (method === 'get_market') {
        // Simulate route change while get_market is in flight
        activeRoute = '#9';
        return {
          question: 'Stale market #4',
          kind: ['Event'],
          closes_at: 2000n,
          deadline: 88400n,
          status: 0,
          yes_pool: 0n,
          no_pool: 0n,
          outcome: 0,
          confidence: 0,
        };
      }
      if (method === 'get_position') {
        // Simulate wallet switch while get_position is in flight
        activeWallet = walletB;
        return {amount: 500n, side: 0, claimed: false};
      }
    },
  };

  const staleRouteRes = await loadMarketDetail({
    hash: '#4',
    markets: [],
    positions: {},
    client: slowClient,
    source: walletA,
    address: walletA,
    isCurrent: () => activeRoute === '#4' && activeWallet === walletA,
  });

  assert.equal(staleRouteRes.committed, false);
  assert.equal(staleRouteRes.market, null);
  assert.equal(staleRouteRes.position, null);
});
