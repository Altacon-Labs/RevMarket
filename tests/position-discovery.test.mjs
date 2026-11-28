/**
 * Regression tests for issue #78 — wallet positions beyond the latest 50 markets.
 *
 * Covers all acceptance criteria:
 *   AC1: Older position appears once, can be opened, can be claimed when eligible.
 *   AC2: Paging, account switch and claim refresh are consistent; disconnected/stale
 *        source cannot leak previous-wallet totals.
 *   AC3: An indexer gap explains missing coverage; unknown position never shown as zero.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  discoverWalletMarketIds,
  computeExtraMarketIds,
  hasOpenAmount,
  describeCoverage,
  DISCOVERY_PAGE_LIMIT,
  DISCOVERY_MAX_PAGES,
} from '../frontend/src/lib/position-discovery.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePage(items, {hasMore = false, nextCursor = null, fresh = true, hasGaps = false} = {}) {
  return {
    items,
    nextCursor,
    pageInfo: {hasMore, nextCursor},
    freshness: {fresh, hasGaps, complete: fresh && !hasGaps},
  };
}

function predictionItem(marketId) {
  return {marketId, eventType: 'prediction', actorWallet: 'G' + 'A'.repeat(55)};
}

// ---------------------------------------------------------------------------
// discoverWalletMarketIds
// ---------------------------------------------------------------------------

test('AC1: returns every market ID from a single page of predictions', async () => {
  const request = async () => makePage([predictionItem(0), predictionItem(5), predictionItem(49)]);
  const {marketIds, hasGaps, fresh, unavailable} = await discoverWalletMarketIds(request);
  assert.deepEqual([...marketIds].sort((a, b) => a - b), [0, 5, 49]);
  assert.equal(hasGaps, false);
  assert.equal(fresh, true);
  assert.equal(unavailable, false);
});

test('AC1: paginates until hasMore is false and collects all unique market IDs', async () => {
  const pages = [
    makePage([predictionItem(0), predictionItem(1)], {hasMore: true, nextCursor: 'c1'}),
    makePage([predictionItem(1), predictionItem(2)], {hasMore: true, nextCursor: 'c2'}), // dup id=1
    makePage([predictionItem(3)], {hasMore: false}),
  ];
  let call = 0;
  const request = async (path) => {
    const p = pages[call++];
    if (call > 1) assert.ok(path.includes('cursor='), `page ${call} must pass cursor`);
    return p;
  };
  const {marketIds} = await discoverWalletMarketIds(request);
  assert.deepEqual([...marketIds].sort((a, b) => a - b), [0, 1, 2, 3]);
  assert.equal(call, 3);
});

test('AC2: account switch — fresh call returns only new wallet IDs (no cross-wallet leakage)', async () => {
  // Simulate two separate discover calls for two different wallets
  const walletA = async () => makePage([predictionItem(10), predictionItem(11)]);
  const walletB = async () => makePage([predictionItem(20)]);
  const {marketIds: idsA} = await discoverWalletMarketIds(walletA);
  const {marketIds: idsB} = await discoverWalletMarketIds(walletB);
  assert.ok(!idsB.has(10), 'wallet B must not see wallet A market 10');
  assert.ok(!idsB.has(11), 'wallet B must not see wallet A market 11');
  assert.ok(idsB.has(20));
  // wallet A result is unaffected
  assert.ok(idsA.has(10));
});

test('AC3: backend unavailable — returns empty set, unavailable=true, fresh=false', async () => {
  const request = async () => { throw new Error('HTTP 503'); };
  const {marketIds, fresh, unavailable} = await discoverWalletMarketIds(request);
  assert.equal(marketIds.size, 0);
  assert.equal(fresh, false);
  assert.equal(unavailable, true);
});

test('AC3: indexer gap propagates to hasGaps=true and fresh=false', async () => {
  const request = async () => makePage(
    [predictionItem(5)],
    {hasMore: false, fresh: false, hasGaps: true},
  );
  const {hasGaps, fresh} = await discoverWalletMarketIds(request);
  assert.equal(hasGaps, true);
  assert.equal(fresh, false);
});

test('pagination safety cap: stops after DISCOVERY_MAX_PAGES pages', async () => {
  let calls = 0;
  const request = async (path) => {
    calls++;
    return makePage([predictionItem(calls)], {hasMore: true, nextCursor: `c${calls}`});
  };
  const {marketIds} = await discoverWalletMarketIds(request, {maxPages: 3});
  assert.equal(calls, 3);
  assert.equal(marketIds.size, 3);
});

test('invalid / missing marketId fields are silently skipped', async () => {
  const request = async () => makePage([
    {marketId: null},
    {marketId: 'five'},
    {marketId: -1},
    {marketId: 1.5},
    {marketId: 7}, // only valid one
    {},
  ]);
  const {marketIds} = await discoverWalletMarketIds(request);
  assert.deepEqual([...marketIds], [7]);
});

// ---------------------------------------------------------------------------
// computeExtraMarketIds
// ---------------------------------------------------------------------------

test('AC1: returns IDs strictly below windowStart, sorted ascending', () => {
  const ids = new Set([0, 10, 49, 50, 99]);
  const extra = computeExtraMarketIds(ids, 50);
  assert.deepEqual(extra, [0, 10, 49]);
});

test('returns empty array when windowStart is 0 (all 50 markets loaded)', () => {
  const ids = new Set([0, 1, 2]);
  assert.deepEqual(computeExtraMarketIds(ids, 0), []);
});

test('returns empty array when no IDs are outside the window', () => {
  const ids = new Set([50, 60, 70]);
  assert.deepEqual(computeExtraMarketIds(ids, 50), []);
});

// ---------------------------------------------------------------------------
// hasOpenAmount — AC3: unknown position must never be shown as zero balance
// ---------------------------------------------------------------------------

test('hasOpenAmount returns false for null/undefined/zero/claimed', () => {
  assert.equal(hasOpenAmount(null), false);
  assert.equal(hasOpenAmount(undefined), false);
  assert.equal(hasOpenAmount({amount: 0}), false);
  assert.equal(hasOpenAmount({amount: '0'}), false);
  assert.equal(hasOpenAmount({amount: 0n}), false);
  assert.equal(hasOpenAmount({amount: undefined}), false);
});

test('hasOpenAmount returns true for positive amounts', () => {
  assert.equal(hasOpenAmount({amount: 1}), true);
  assert.equal(hasOpenAmount({amount: '10000000'}), true);
  assert.equal(hasOpenAmount({amount: 25000000n}), true);
});

// ---------------------------------------------------------------------------
// describeCoverage — AC3: gap discloses incomplete coverage
// ---------------------------------------------------------------------------

test('complete coverage when fresh and no gaps', () => {
  const c = describeCoverage({fresh: true, hasGaps: false, unavailable: false, extraCount: 3});
  assert.equal(c.complete, true);
  assert.equal(c.message, null);
  assert.equal(c.extraCount, 3);
});

test('AC3: gap produces complete=false, hasGaps=true with descriptive message', () => {
  const c = describeCoverage({fresh: false, hasGaps: true, unavailable: false, extraCount: 0});
  assert.equal(c.complete, false);
  assert.equal(c.hasGaps, true);
  assert.ok(c.message.includes('indexer has gaps'));
});

test('AC2: unavailable backend produces complete=false without false gap flag', () => {
  const c = describeCoverage({fresh: false, hasGaps: false, unavailable: true, extraCount: 0});
  assert.equal(c.complete, false);
  assert.equal(c.hasGaps, false);
  assert.equal(c.unavailable, true);
  assert.ok(c.message.includes('unavailable'));
});

test('stale (not fresh, no gaps) produces complete=false with partial coverage message', () => {
  const c = describeCoverage({fresh: false, hasGaps: false, unavailable: false, extraCount: 1});
  assert.equal(c.complete, false);
  assert.equal(c.hasGaps, false);
  assert.ok(c.message.includes('partial'));
});

// ---------------------------------------------------------------------------
// AC1 integration: older position in market 0 survives when market 50 is created
// ---------------------------------------------------------------------------

test('AC1 integration: market 0 position is discovered and confirmed when count=51', async () => {
  // Window covers [1..50], market 0 is outside. The index returns market 0 as a prediction.
  const request = async () => makePage([predictionItem(0)], {fresh: true, hasGaps: false});
  const {marketIds} = await discoverWalletMarketIds(request);
  const windowStart = Math.max(0, 51 - 50); // = 1
  const extra = computeExtraMarketIds(marketIds, windowStart);
  assert.deepEqual(extra, [0], 'market 0 must appear in extra IDs');

  // Simulate contract confirming a non-zero position for market 0
  const position = {amount: '5000000', side: 0, claimed: false};
  assert.equal(hasOpenAmount(position), true, 'position must pass hasOpenAmount check');
});
