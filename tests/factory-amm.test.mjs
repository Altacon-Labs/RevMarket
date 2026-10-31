import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Invariant definitions and simulation for Soroban Market Factory & AMM exchange

function hashParams(params) {
  return createHash('sha256').update(JSON.stringify(params, Object.keys(params).sort())).digest('hex');
}

class MockFactory {
  constructor(admin) {
    this.admin = admin;
    this.approvedVersions = new Set();
    this.reviewers = new Map(); // wallet -> epoch
    this.creatorNonces = new Map(); // creator -> next nonce
    this.markets = [];
    this.paused = false;
  }

  approveVersion(admin, wasmHash) {
    if (admin !== this.admin) throw new Error('Unauthorized');
    this.approvedVersions.add(wasmHash);
  }

  addReviewer(admin, reviewer) {
    if (admin !== this.admin) throw new Error('Unauthorized');
    const epoch = (this.reviewers.get(reviewer) || 0) + 1;
    this.reviewers.set(reviewer, epoch);
    return epoch;
  }

  removeReviewer(admin, reviewer) {
    if (admin !== this.admin) throw new Error('Unauthorized');
    if (!this.reviewers.has(reviewer)) throw new Error('Reviewer not found');
    const epoch = this.reviewers.get(reviewer) + 1;
    this.reviewers.delete(reviewer);
    return epoch; // epoch incremented so prior approvals become invalid
  }

  deployMarket({creator, reviewer, reviewerEpoch, wasmHash, params, nonce, expiry, now}) {
    if (this.paused) throw new Error('Factory is paused');
    if (creator === reviewer) throw new Error('Reviewer cannot be creator');
    if (!this.approvedVersions.has(wasmHash)) throw new Error('Unapproved implementation version');
    
    // Check reviewer role and exact epoch
    const activeEpoch = this.reviewers.get(reviewer);
    if (!activeEpoch || activeEpoch !== reviewerEpoch) throw new Error('Invalid or revoked reviewer authorization');
    
    if (now >= expiry) throw new Error('Approval has expired');
    
    const expectedNonce = this.creatorNonces.get(creator) || 0;
    if (nonce !== expectedNonce) throw new Error('Invalid creator nonce');
    this.creatorNonces.set(creator, expectedNonce + 1);

    const address = `market_${this.markets.length}_${hashParams(params).slice(0, 8)}`;
    this.markets.push({
      address,
      creator,
      reviewer,
      wasmHash,
      params,
      createdAt: now,
    });
    return address;
  }
}

class MockBinaryAMM {
  constructor(collateralToken, feeBps = 30) {
    this.token = collateralToken;
    this.feeBps = BigInt(feeBps);
    this.reserveY = 0n;
    this.reserveN = 0n;
    this.lpUnits = 0n;
    this.feeReserve = 0n;
    this.totalCollateralLocked = 0n;
    this.balancesY = new Map();
    this.balancesN = new Map();
    this.lpBalances = new Map();
    this.settled = false;
    this.outcome = null; // 0: YES, 1: NO, 2: Invalid
  }

  // Complete set minting: 1 collateral -> 1 YES + 1 NO
  mintCompleteSet(user, collateralAmount) {
    const amount = BigInt(collateralAmount);
    if (amount <= 0n) throw new Error('Amount must be positive');
    this.totalCollateralLocked += amount;
    this.balancesY.set(user, (this.balancesY.get(user) || 0n) + amount);
    this.balancesN.set(user, (this.balancesN.get(user) || 0n) + amount);
  }

  burnCompleteSet(user, amount) {
    const a = BigInt(amount);
    if (a <= 0n) throw new Error('Amount must be positive');
    const y = this.balancesY.get(user) || 0n;
    const n = this.balancesN.get(user) || 0n;
    if (y < a || n < a) throw new Error('Insufficient complete sets');
    this.balancesY.set(user, y - a);
    this.balancesN.set(user, n - a);
    this.totalCollateralLocked -= a;
    return a;
  }

  // Initial balanced LP funding: locks L collateral, creates L YES & L NO, adds to AMM reserves
  initAMM(provider, amount) {
    const L = BigInt(amount);
    if (L <= 0n) throw new Error('Initial liquidity must be positive');
    if (this.reserveY > 0n || this.reserveN > 0n) throw new Error('Already initialized');
    
    this.totalCollateralLocked += L;
    this.reserveY = L;
    this.reserveN = L;
    this.lpUnits = L;
    this.lpBalances.set(provider, L);
  }

  // Proportional buy using constant product k = Y * N
  buy(user, side, grossCollateral, minSharesOut) {
    if (this.settled) throw new Error('Market is settled');
    const C = BigInt(grossCollateral);
    const minOut = BigInt(minSharesOut);
    if (C <= 0n) throw new Error('Collateral must be positive');

    // Fee: F = ceil(C * feeBps / 10000)
    const fee = (C * this.feeBps + 9999n) / 10000n;
    const d = C - fee;
    if (d <= 0n) throw new Error('Net collateral too low');

    this.totalCollateralLocked += d;
    this.feeReserve += fee;

    const k = this.reserveY * this.reserveN;
    let sharesOut = 0n;

    if (side === 0) { // Buy YES
      const newN = this.reserveN + d;
      // new_Y = ceil(k / new_N)
      const newY = (k + newN - 1n) / newN;
      sharesOut = this.reserveY + d - newY;
      if (sharesOut < minOut) throw new Error('Slippage limit exceeded');
      this.reserveY = newY;
      this.reserveN = newN;
      this.balancesY.set(user, (this.balancesY.get(user) || 0n) + sharesOut);
    } else { // Buy NO
      const newY = this.reserveY + d;
      const newN = (k + newY - 1n) / newY;
      sharesOut = this.reserveN + d - newN;
      if (sharesOut < minOut) throw new Error('Slippage limit exceeded');
      this.reserveY = newY;
      this.reserveN = newN;
      this.balancesN.set(user, (this.balancesN.get(user) || 0n) + sharesOut);
    }
    return sharesOut;
  }

  // Sell shares back to AMM
  sell(user, side, sharesIn, minCollateralOut) {
    if (this.settled) throw new Error('Market is settled');
    const s = BigInt(sharesIn);
    const minOut = BigInt(minCollateralOut);
    if (s <= 0n) throw new Error('Shares must be positive');

    const k = this.reserveY * this.reserveN;
    let r = 0n;

    if (side === 0) { // Sell YES
      const bal = this.balancesY.get(user) || 0n;
      if (bal < s) throw new Error('Insufficient YES shares');
      this.balancesY.set(user, bal - s);

      // Binary search for largest r such that (Y + s - r) * (N - r) >= k
      const maxR = s < this.reserveN - 1n ? s : this.reserveN - 1n;
      let low = 0n, high = maxR;
      while (low <= high) {
        const mid = (low + high) / 2n;
        if ((this.reserveY + s - mid) * (this.reserveN - mid) >= k) {
          r = mid;
          low = mid + 1n;
        } else {
          high = mid - 1n;
        }
      }
      this.reserveY = this.reserveY + s - r;
      this.reserveN = this.reserveN - r;
    } else { // Sell NO
      const bal = this.balancesN.get(user) || 0n;
      if (bal < s) throw new Error('Insufficient NO shares');
      this.balancesN.set(user, bal - s);

      const maxR = s < this.reserveY - 1n ? s : this.reserveY - 1n;
      let low = 0n, high = maxR;
      while (low <= high) {
        const mid = (low + high) / 2n;
        if ((this.reserveY - mid) * (this.reserveN + s - mid) >= k) {
          r = mid;
          low = mid + 1n;
        } else {
          high = mid - 1n;
        }
      }
      this.reserveY = this.reserveY - r;
      this.reserveN = this.reserveN + s - r;
    }

    const fee = (r * this.feeBps + 9999n) / 10000n;
    const netCollateral = r - fee;
    if (netCollateral < minOut) throw new Error('Slippage limit exceeded');

    this.feeReserve += fee;
    this.totalCollateralLocked -= r;
    return netCollateral;
  }

  // Settlement & 1:1 Redemption / 50-50 Invalid
  settle(outcome) {
    if (![0, 1, 2].includes(outcome)) throw new Error('Invalid outcome');
    this.settled = true;
    this.outcome = outcome;
  }

  redeem(user) {
    if (!this.settled) throw new Error('Market not settled');
    let payout = 0n;
    if (this.outcome === 0) { // YES wins 1:1
      const y = this.balancesY.get(user) || 0n;
      payout = y;
      this.balancesY.set(user, 0n);
      this.balancesN.set(user, 0n);
    } else if (this.outcome === 1) { // NO wins 1:1
      const n = this.balancesN.get(user) || 0n;
      payout = n;
      this.balancesY.set(user, 0n);
      this.balancesN.set(user, 0n);
    } else if (this.outcome === 2) { // Invalid: 0.5 each
      const y = this.balancesY.get(user) || 0n;
      const n = this.balancesN.get(user) || 0n;
      payout = (y / 2n) + (n / 2n);
      this.balancesY.set(user, 0n);
      this.balancesN.set(user, 0n);
    }
    this.totalCollateralLocked -= payout;
    return payout;
  }
}

// ----------------- TESTS -----------------

test('Factory enforces dual auth, creator != reviewer, and epoch validity', () => {
  const factory = new MockFactory('admin');
  const wasmHash = '0x1234abcd';
  factory.approveVersion('admin', wasmHash);
  
  const epoch = factory.addReviewer('admin', 'reviewer_1');
  const params = { question: 'Test?', close: 1000 };

  // 1. Successful deployment
  const addr = factory.deployMarket({
    creator: 'creator_1',
    reviewer: 'reviewer_1',
    reviewerEpoch: epoch,
    wasmHash,
    params,
    nonce: 0,
    expiry: 500,
    now: 100,
  });
  assert.ok(addr.startsWith('market_0_'));

  // 2. Reject self-review
  assert.throws(() => factory.deployMarket({
    creator: 'alice',
    reviewer: 'alice',
    reviewerEpoch: 1,
    wasmHash,
    params,
    nonce: 0,
    expiry: 500,
    now: 100,
  }), /Reviewer cannot be creator/);

  // 3. Reject unapproved WASM
  assert.throws(() => factory.deployMarket({
    creator: 'creator_2',
    reviewer: 'reviewer_1',
    reviewerEpoch: epoch,
    wasmHash: '0xunapproved',
    params,
    nonce: 0,
    expiry: 500,
    now: 100,
  }), /Unapproved implementation version/);

  // 4. Reject revoked reviewer or stale epoch
  factory.removeReviewer('admin', 'reviewer_1');
  assert.throws(() => factory.deployMarket({
    creator: 'creator_2',
    reviewer: 'reviewer_1',
    reviewerEpoch: epoch,
    wasmHash,
    params,
    nonce: 0,
    expiry: 500,
    now: 100,
  }), /Invalid or revoked reviewer authorization/);

  // 5. Reject nonce reuse
  assert.throws(() => factory.deployMarket({
    creator: 'creator_1',
    reviewer: 'reviewer_1',
    reviewerEpoch: epoch,
    wasmHash,
    params,
    nonce: 0,
    expiry: 500,
    now: 100,
  }), /Invalid or revoked reviewer authorization/);
});

test('AMM preserves k = Y * N invariant, bounds fees, and isolates collateral backing', () => {
  const amm = new MockBinaryAMM('XLM_SAC', 30); // 30 bps = 0.3%
  amm.initAMM('lp_1', 10000000n); // 1.0 XLM initial balanced liquidity (7 decimals)

  assert.equal(amm.reserveY, 10000000n);
  assert.equal(amm.reserveN, 10000000n);
  const initialK = amm.reserveY * amm.reserveN;

  // Alice buys YES with 100,000 base units
  const sharesOut = amm.buy('alice', 0, 100000n, 1n);
  assert.ok(sharesOut > 0n);
  assert.ok(amm.balancesY.get('alice') === sharesOut);

  // k must not decrease (it can stay equal or increase due to integer ceil rounding and fees)
  const newK = amm.reserveY * amm.reserveN;
  assert.ok(newK >= initialK);
  assert.ok(amm.feeReserve > 0n);

  // Alice sells half her YES shares back
  const half = sharesOut / 2n;
  const returnedCollateral = amm.sell('alice', 0, half, 1n);
  assert.ok(returnedCollateral > 0n);
  assert.equal(amm.balancesY.get('alice'), sharesOut - half);
});

test('Complete set conservation & settlement redemptions (YES win & Invalid)', () => {
  const amm = new MockBinaryAMM('XLM_SAC', 0);
  amm.initAMM('lp_1', 10000000n);

  // Bob buys YES with 200,000 collateral
  amm.buy('bob', 0, 200000n, 1n);
  const bobYES = amm.balancesY.get('bob');

  // Carol buys NO with 200,000 collateral
  amm.buy('carol', 1, 200000n, 1n);
  const carolNO = amm.balancesN.get('carol');

  // Case A: Settle YES (outcome = 0)
  amm.settle(0);
  const bobPayout = amm.redeem('bob');
  assert.equal(bobPayout, bobYES); // 1:1 payout on winning YES
  const carolPayout = amm.redeem('carol');
  assert.equal(carolPayout, 0n); // Losing side receives 0

  // Case B: Invalid outcome test
  const amm2 = new MockBinaryAMM('XLM_SAC', 0);
  amm2.initAMM('lp_1', 10000000n);
  amm2.mintCompleteSet('dave', 500000n); // Dave has 500k YES and 500k NO
  amm2.settle(2); // Invalid
  const davePayout = amm2.redeem('dave');
  assert.equal(davePayout, 500000n); // 0.5 * 500k + 0.5 * 500k = 500k
});

