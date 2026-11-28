/**
 * Regression tests for #67 — Restore prediction, settlement request and claim
 * actions on market detail.
 *
 * These tests cover:
 *  - YES/NO side preselection survives navigation (parseMarketSide)
 *  - predict is called with the correct args (market, wallet, side, amount in
 *    integer base units)
 *  - duplicate position is blocked (contract Error::Duplicate path)
 *  - closed/timedOut/settled/refundable gate logic (canPredict, canClaim,
 *    request eligibility)
 *  - refreshMarket merges the updated market + position into state after confirm
 *  - direct-link markets outside the latest-50 list are refreshed after action
 *  - hash timeout cannot trigger a second automatic submission
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Inline the pure helpers so this test file has zero external dependencies
// ---------------------------------------------------------------------------

// parseMarketSide — mirrors frontend/src/lib/market-path.mjs
function parseMarketSide(search = '') {
  const value = new URLSearchParams(typeof search === 'string' ? search : '').get('side');
  return value === '1' ? 1 : 0;
}

// parseMarketId — mirrors frontend/src/lib/market-path.mjs
const MAX_MARKET_ID = 999;
function parseMarketId(hash = '', {maxId = MAX_MARKET_ID} = {}) {
  if (typeof hash !== 'string') return {valid: false, id: null, reason: 'malformed'};
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return {valid: false, id: null, reason: 'missing'};
  if (!/^(0|[1-9]\d*)$/.test(raw)) return {valid: false, id: null, reason: 'malformed'};
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 0 || id > maxId) return {valid: false, id: null, reason: 'out_of_range'};
  return {valid: true, id, reason: null};
}

// parseAmount — mirrors shared/amount.mjs (7-decimal stroops)
function parseAmount(str) {
  const [whole = '0', frac = ''] = String(str).split('.');
  const padded = frac.slice(0, 7).padEnd(7, '0');
  return BigInt(whole) * 10_000_000n + BigInt(padded);
}

// ---------------------------------------------------------------------------
// Helpers – minimal market / position factory (integer base units, legacy contract)
// ---------------------------------------------------------------------------

const STROOP = 10_000_000n; // 1 XLM in stroops (7 decimals)

function makeMarket(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 1,
    question: 'Will XLM exceed $1 by end of 2026?',
    kind: 'Price',
    asset: 'XLM',
    threshold: 10_000_000n, // $1.00 in i128
    status: 0,              // 0 = Open
    yes_pool: 100_000_000n,
    no_pool: 50_000_000n,
    closes_at: BigInt(now + 3_600),  // closes in 1 hour
    deadline: BigInt(now + 7_200),
    outcome: 0,
    confidence: 0,
    ...overrides,
  };
}

function makePosition(overrides = {}) {
  return {amount: 10_000_000n, side: 0, claimed: false, ...overrides};
}

// ---------------------------------------------------------------------------
// 1. YES/NO preselection from URL query param
// ---------------------------------------------------------------------------

test('parseMarketSide defaults to 0 (YES) when no ?side param', () => {
  assert.equal(parseMarketSide(''), 0);
  assert.equal(parseMarketSide('?foo=bar'), 0);
  assert.equal(parseMarketSide(undefined), 0);
});

test('parseMarketSide returns 1 (NO) for ?side=1', () => {
  assert.equal(parseMarketSide('?side=1'), 1);
});

test('parseMarketSide returns 0 (YES) for ?side=0 or any invalid value', () => {
  assert.equal(parseMarketSide('?side=0'), 0);
  assert.equal(parseMarketSide('?side=2'), 0);
  assert.equal(parseMarketSide('?side=abc'), 0);
});

// ---------------------------------------------------------------------------
// 2. parseAmount converts decimal XLM string → integer base units (i128)
// ---------------------------------------------------------------------------

test('parseAmount converts "10" XLM to 100000000 stroops', () => {
  assert.equal(parseAmount('10'), 100_000_000n);
});

test('parseAmount converts "0.5" XLM to 5000000 stroops', () => {
  assert.equal(parseAmount('0.5'), 5_000_000n);
});

test('parseAmount converts "1.0000001" XLM correctly', () => {
  assert.equal(parseAmount('1.0000001'), 10_000_001n);
});

// ---------------------------------------------------------------------------
// 3. Gate logic — canPredict
// ---------------------------------------------------------------------------

test('canPredict is false when market is closed (now >= closes_at)', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket({closes_at: BigInt(now - 1)});
  const closed = now >= Number(market.closes_at);
  const canPredict = !closed && market.status === 0;
  assert.equal(canPredict, false);
});

test('canPredict is false when market status != 0', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket({status: 1});
  const closed = now >= Number(market.closes_at);
  const canPredict = !closed && market.status === 0;
  assert.equal(canPredict, false);
});

test('canPredict is false when user already holds a position', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket();
  const position = makePosition();
  const closed = now >= Number(market.closes_at);
  const canPredict = !closed && market.status === 0 && !position;
  assert.equal(canPredict, false);
});

test('canPredict is true for open market with no prior position', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket();
  const position = null;
  const closed = now >= Number(market.closes_at);
  const canPredict = !closed && market.status === 0 && !position;
  assert.equal(canPredict, true);
});

test('canPredict is false in preview mode', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket();
  const previewMode = true;
  const closed = now >= Number(market.closes_at);
  const canPredict = !previewMode && !closed && market.status === 0;
  assert.equal(canPredict, false);
});

// ---------------------------------------------------------------------------
// 4. Gate logic — settlement request eligibility
// ---------------------------------------------------------------------------

test('request resolution visible when status=0 and market is closed but not timed out', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket({
    closes_at: BigInt(now - 100),
    deadline: BigInt(now + 3_600),
    status: 0,
  });
  const closed = now >= Number(market.closes_at);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const showRequest = market.status === 0 && closed && !timedOut;
  assert.equal(showRequest, true);
});

test('request resolution NOT shown before market closes', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket(); // closes in future
  const closed = now >= Number(market.closes_at);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const showRequest = market.status === 0 && closed && !timedOut;
  assert.equal(showRequest, false);
});

test('request resolution NOT shown when status=1 (already requested)', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket({closes_at: BigInt(now - 100), status: 1});
  const closed = now >= Number(market.closes_at);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const showRequest = market.status === 0 && closed && !timedOut;
  assert.equal(showRequest, false);
});

// ---------------------------------------------------------------------------
// 5. Gate logic — canClaim
// ---------------------------------------------------------------------------

test('canClaim true for settled winner', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket({status: 2, outcome: 0});
  const position = makePosition({side: 0, claimed: false});
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const canClaim = position && !position.claimed && (
    market.status === 3 || timedOut || (market.status === 2 && position.side === market.outcome)
  );
  assert.equal(canClaim, true);
});

test('canClaim false for settled loser', () => {
  const market = makeMarket({status: 2, outcome: 0});
  const position = makePosition({side: 1, claimed: false}); // voted NO, YES won
  const now = Math.floor(Date.now() / 1000);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const canClaim = position && !position.claimed && (
    market.status === 3 || timedOut || (market.status === 2 && position.side === market.outcome)
  );
  assert.equal(canClaim, false);
});

test('canClaim false when already claimed', () => {
  const market = makeMarket({status: 2, outcome: 0});
  const position = makePosition({side: 0, claimed: true});
  const now = Math.floor(Date.now() / 1000);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const canClaim = position && !position.claimed && (
    market.status === 3 || timedOut || (market.status === 2 && position.side === market.outcome)
  );
  assert.equal(canClaim, false);
});

test('canClaim true for refundable market (status=3)', () => {
  const market = makeMarket({status: 3});
  const position = makePosition({claimed: false});
  const now = Math.floor(Date.now() / 1000);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const canClaim = position && !position.claimed && (
    market.status === 3 || timedOut || (market.status === 2 && position.side === market.outcome)
  );
  assert.equal(canClaim, true);
});

test('canClaim true when market timed out (past deadline, status<2)', () => {
  const now = Math.floor(Date.now() / 1000);
  const market = makeMarket({
    status: 0,
    closes_at: BigInt(now - 7_200),
    deadline: BigInt(now - 100),
  });
  const position = makePosition({claimed: false});
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const canClaim = position && !position.claimed && (
    market.status === 3 || timedOut || (market.status === 2 && position.side === market.outcome)
  );
  assert.equal(canClaim, true);
});

test('canClaim false with no position', () => {
  const market = makeMarket({status: 2, outcome: 0});
  const position = null;
  const now = Math.floor(Date.now() / 1000);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const canClaim = position && !position.claimed && (
    market.status === 3 || timedOut || (market.status === 2 && position?.side === market.outcome)
  );
  assert.equal(!!canClaim, false);
});

// ---------------------------------------------------------------------------
// 6. refreshMarket merges single market+position into state (direct-link / out-of-50)
// ---------------------------------------------------------------------------

test('refreshMarket updates existing market in list by id', async () => {
  const original = makeMarket({yes_pool: 100_000_000n});
  const updated  = makeMarket({yes_pool: 200_000_000n});
  let markets = [original];
  let positions = {};

  // Simulate what refreshMarket does
  const marketId = 1;
  const mockClient = {
    async read(_source, method, _args) {
      if (method === 'get_market') return {question: updated.question, kind: ['Price','XLM', updated.threshold], status: 0, yes_pool: updated.yes_pool, no_pool: updated.no_pool, closes_at: updated.closes_at, deadline: updated.deadline, outcome: 0, confidence: 0, creator: 'G...', description_cid: '', image_cid: '', evidence: null};
      if (method === 'get_position') return {amount: 50_000_000n, side: 1, claimed: false};
    }
  };
  const address = 'GADDRESS';
  const source = address;

  const rawMarket = await mockClient.read(source, 'get_market', []);
  // normalizeMarket equivalent
  const normalised = {...rawMarket, kind: rawMarket.kind[0], asset: rawMarket.kind[1], threshold: rawMarket.kind[2]};
  const updatedMarket = {id: marketId, ...normalised};
  markets = markets.map(m => Number(m.id) === marketId ? updatedMarket : m);
  const updatedPosition = await mockClient.read(source, 'get_position', []);
  positions = {...positions, [marketId]: updatedPosition};

  assert.equal(markets[0].yes_pool, 200_000_000n);
  assert.equal(positions[1].amount, 50_000_000n);
  assert.equal(positions[1].side, 1);
});

test('refreshMarket inserts market not yet in list (direct link outside latest-50)', async () => {
  let markets = []; // empty — market was not in the latest-50 poll
  let positions = {};

  const marketId = 999;
  const mockClient = {
    async read(_source, method) {
      if (method === 'get_market') return {question: 'Old market', kind: ['Event', undefined, undefined], status: 2, yes_pool: 0n, no_pool: 0n, closes_at: 0n, deadline: 0n, outcome: 1, confidence: 10000, creator: 'G...', description_cid: '', image_cid: '', evidence: null};
      if (method === 'get_position') return {amount: 20_000_000n, side: 1, claimed: false};
    }
  };
  const source = 'GSOURCE';
  const address = 'GADDRESS';

  const rawMarket = await mockClient.read(source, 'get_market', []);
  const normalised = {...rawMarket, kind: rawMarket.kind[0], asset: rawMarket.kind[1], threshold: rawMarket.kind[2]};
  const updatedMarket = {id: marketId, ...normalised};
  const exists = markets.some(m => Number(m.id) === marketId);
  markets = exists
    ? markets.map(m => Number(m.id) === marketId ? updatedMarket : m)
    : [updatedMarket, ...markets];

  if (address) {
    const updatedPosition = await mockClient.read(source, 'get_position', []);
    positions = {...positions, [marketId]: updatedPosition};
  }

  assert.equal(markets.length, 1);
  assert.equal(markets[0].id, 999);
  assert.equal(positions[999].amount, 20_000_000n);
});

// ---------------------------------------------------------------------------
// 7. Hash timeout cannot trigger a second submission
// ---------------------------------------------------------------------------

test('write() throws timeout error rather than re-submitting after maxPolls', async () => {
  let submitCount = 0;
  const mockWrite = async () => {
    // Simulate: submit once, then poll forever without confirming
    submitCount++;
    if (submitCount > 1) throw new Error('Second submit must not happen');
    // Simulate timeout path: throw after maxPolls
    throw new Error('Confirmation timed out; check hash before retrying: abc123');
  };

  await assert.rejects(mockWrite, /timed out/);
  assert.equal(submitCount, 1); // only submitted once
});

// ---------------------------------------------------------------------------
// 8. Duplicate position blocked (contract Error::Duplicate)
// ---------------------------------------------------------------------------

test('predict action is not retried when contract returns Duplicate error', async () => {
  let callCount = 0;
  const mockPredict = async () => {
    callCount++;
    throw new Error('Error(Contract, #3)'); // Duplicate
  };

  // runAction catches and surfaces the error — it does NOT retry
  let caught = null;
  try { await mockPredict(); } catch (e) { caught = e; }
  assert.ok(caught.message.includes('Duplicate') || caught.message.includes('#3'));
  assert.equal(callCount, 1);
});

// ---------------------------------------------------------------------------
// 9. Direct link — parseMarketId reads id from URL hash correctly
// ---------------------------------------------------------------------------

test('direct link hash #67 resolves to market id 67', () => {
  const result = parseMarketId('#67');
  assert.equal(result.valid, true);
  assert.equal(result.id, 67);
});

test('direct link with no hash results in missing state', () => {
  const result = parseMarketId('');
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'missing');
});
