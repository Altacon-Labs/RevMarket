import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateLegacyPayout, parseStakeUnits, poolShares} from '../frontend/src/lib/pool-math.mjs';

test('stake parsing preserves seven-decimal XLM base units', () => {
  assert.equal(parseStakeUnits('90'), 900_000_000n);
  assert.equal(parseStakeUnits('0.0000001'), 1n);
  assert.equal(parseStakeUnits('1.12345678'), 0n);
});

test('legacy payout includes the proposed stake and floors integer division', () => {
  // Existing YES/NO pools are 90/10 XLM; a 10 XLM YES stake produces
  // 10 * (100 + 10) / (90 + 10) = 11 XLM, not 10 / 90%.
  assert.equal(estimateLegacyPayout({yesPool: 900_000_000n, noPool: 100_000_000n, side: 0, stake: 100_000_000n}), 110_000_000n);
  assert.equal(estimateLegacyPayout({yesPool: 900_000_000n, noPool: 100_000_000n, side: 1, stake: 100_000_000n}), 200_000_000n);
  assert.equal(estimateLegacyPayout({yesPool: 1n, noPool: 0n, side: 0, stake: 1n}), 2n);
});

test('empty and one-sided pools have mathematically honest payout estimates', () => {
  assert.equal(estimateLegacyPayout({yesPool: 0n, noPool: 0n, side: 0, stake: 10_000_000n}), 10_000_000n);
  assert.equal(estimateLegacyPayout({yesPool: 0n, noPool: 100_000_000n, side: 0, stake: 10_000_000n}), 110_000_000n);
  assert.equal(estimateLegacyPayout({yesPool: 100_000_000n, noPool: 0n, side: 1, stake: 10_000_000n}), 110_000_000n);
});

test('pool shares are unavailable for empty pools and exact for one-sided pools', () => {
  assert.equal(poolShares(0n, 0n), null);
  assert.deepEqual(poolShares(900_000_000n, 100_000_000n), {yes: 90, no: 10});
  assert.deepEqual(poolShares(100_000_000n, 0n), {yes: 100, no: 0});
  assert.deepEqual(poolShares(0n, 100_000_000n), {yes: 0, no: 100});
});
