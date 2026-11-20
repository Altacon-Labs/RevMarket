#![no_std]

//! Deterministic binary Fixed-Product Market Maker (FPMM) quote arithmetic.
//!
//! All monetary amounts and outcome-share reserves use signed 128-bit integers (`i128`)
//! denominated in seven-decimal base units (`10^-7`, matching the Stellar Asset Contract
//! scale where `1.0000000` token = `10_000_000` base units).
//!
//! Rounding policy (conservative in favor of pool solvency):
//! - Buy fee: `ceil(gross_input * fee_bps / 10_000)`
//! - Buy post-trade bought reserve: `ceil((yes_reserve * no_reserve) / next_other_reserve)`
//! - Sell gross collateral released: maximum integer `r >= 1` such that
//!   `(sold_reserve + shares_in - r) * (other_reserve - r) >= yes_reserve * no_reserve`
//!   and both post-trade reserves remain within `1..=MAX_RESERVE`
//! - Sell fee: `ceil(gross_collateral_released * fee_bps / 10_000)`

/// Seven-decimal base unit scale (`10^7`).
pub const SCALE: i128 = 10_000_000;

/// Minimum allowed reserve or trade input (`1` base unit).
pub const MIN_RESERVE: i128 = 1;

/// Maximum allowed reserve or trade input (`10^18` base units).
pub const MAX_RESERVE: i128 = 1_000_000_000_000_000_000;

/// Basis-points denominator (`10,000 bps = 100%`).
pub const BPS_DENOMINATOR: i128 = 10_000;

/// Maximum supported fee rate in basis points (`1,000 bps = 10.00%`).
pub const MAX_FEE_BPS: u32 = 1_000;

/// Standard RevMarket Testnet fixture fee rate (`30 bps = 0.30%`).
pub const DEFAULT_TEST_FEE_BPS: u32 = 30;

/// Binary market outcome side.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum Outcome {
    Yes,
    No,
}

/// Alias for [`Outcome`] used by contract interfaces.
pub type Side = Outcome;

/// Deterministic quote result for a binary FPMM buy or sell operation.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub struct Quote {
    /// Net shares bought (for `quote_buy`) or net collateral released (for `quote_sell`).
    pub output: i128,
    /// Collateral fee charged in seven-decimal base units.
    pub fee: i128,
    /// Post-trade YES outcome share reserve in the AMM inventory.
    pub next_yes_reserve: i128,
    /// Post-trade NO outcome share reserve in the AMM inventory.
    pub next_no_reserve: i128,
}

/// Defined error conditions for AMM quote calculations.
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum QuoteError {
    /// Pre-trade reserve is non-positive or exceeds `MAX_RESERVE`.
    InvalidReserve,
    /// Trade input amount is non-positive or exceeds `MAX_RESERVE`.
    InvalidInput,
    /// Fee rate exceeds `MAX_FEE_BPS` (`1,000 bps`).
    InvalidFeeBps,
    /// Post-trade reserve would exceed `MAX_RESERVE`.
    ReserveOverflow,
    /// Net collateral input after fee rounding is zero or negative.
    ZeroNetInput,
    /// Net output shares or collateral after rounding is zero or negative.
    ZeroOutput,
    /// Pool lacks sufficient reserve depth to keep post-trade reserves positive.
    InsufficientLiquidity,
    /// Checked `i128` arithmetic overflowed or underflowed.
    ArithmeticOverflow,
}

fn validate_reserves(yes_reserve: i128, no_reserve: i128) -> Result<(), QuoteError> {
    if !(MIN_RESERVE..=MAX_RESERVE).contains(&yes_reserve)
        || !(MIN_RESERVE..=MAX_RESERVE).contains(&no_reserve)
    {
        return Err(QuoteError::InvalidReserve);
    }
    Ok(())
}

fn validate_input(amount: i128) -> Result<(), QuoteError> {
    if !(MIN_RESERVE..=MAX_RESERVE).contains(&amount) {
        return Err(QuoteError::InvalidInput);
    }
    Ok(())
}

fn validate_fee_bps(fee_bps: u32) -> Result<i128, QuoteError> {
    if fee_bps > MAX_FEE_BPS {
        return Err(QuoteError::InvalidFeeBps);
    }
    Ok(fee_bps as i128)
}

/// Compute `ceil(amount * fee_bps / 10_000)` using checked `i128` arithmetic.
pub fn ceil_fee(amount: i128, fee_bps: u32) -> Result<i128, QuoteError> {
    validate_input(amount)?;
    let bps = validate_fee_bps(fee_bps)?;
    if bps == 0 {
        return Ok(0);
    }
    let prod = amount
        .checked_mul(bps)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    let q = prod / BPS_DENOMINATOR;
    let r = prod % BPS_DENOMINATOR;
    if r > 0 {
        q.checked_add(1).ok_or(QuoteError::ArithmeticOverflow)
    } else {
        Ok(q)
    }
}

fn ceil_div_positive(numerator: i128, denominator: i128) -> Result<i128, QuoteError> {
    if numerator < 0 || denominator <= 0 {
        return Err(QuoteError::ArithmeticOverflow);
    }
    let q = numerator / denominator;
    let r = numerator % denominator;
    if r > 0 {
        q.checked_add(1).ok_or(QuoteError::ArithmeticOverflow)
    } else {
        Ok(q)
    }
}

/// Compute a pure deterministic buy quote for `side` outcome shares.
///
/// Formula:
/// - `fee = ceil(gross_collateral_in * fee_bps / 10_000)`
/// - `net_input = gross_collateral_in - fee`
/// - `k = yes_reserve * no_reserve`
/// - `next_other = other_reserve + net_input`
/// - `next_bought = ceil(k / next_other)`
/// - `shares_out = bought_reserve + net_input - next_bought`
pub fn quote_buy(
    yes_reserve: i128,
    no_reserve: i128,
    side: Outcome,
    gross_collateral_in: i128,
    fee_bps: u32,
) -> Result<Quote, QuoteError> {
    validate_reserves(yes_reserve, no_reserve)?;
    validate_input(gross_collateral_in)?;
    let fee = ceil_fee(gross_collateral_in, fee_bps)?;
    let net_input = gross_collateral_in
        .checked_sub(fee)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    if net_input <= 0 {
        return Err(QuoteError::ZeroNetInput);
    }

    let (bought_reserve, other_reserve) = match side {
        Outcome::Yes => (yes_reserve, no_reserve),
        Outcome::No => (no_reserve, yes_reserve),
    };

    let k = yes_reserve
        .checked_mul(no_reserve)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    let next_other = other_reserve
        .checked_add(net_input)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    if next_other > MAX_RESERVE {
        return Err(QuoteError::ReserveOverflow);
    }

    let next_bought = ceil_div_positive(k, next_other)?;
    if next_bought < MIN_RESERVE {
        return Err(QuoteError::InsufficientLiquidity);
    }
    if next_bought > MAX_RESERVE {
        return Err(QuoteError::ReserveOverflow);
    }

    let total_bought = bought_reserve
        .checked_add(net_input)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    let shares_out = total_bought
        .checked_sub(next_bought)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    if shares_out <= 0 {
        return Err(QuoteError::ZeroOutput);
    }

    let (next_yes_reserve, next_no_reserve) = match side {
        Outcome::Yes => (next_bought, next_other),
        Outcome::No => (next_other, next_bought),
    };

    Ok(Quote {
        output: shares_out,
        fee,
        next_yes_reserve,
        next_no_reserve,
    })
}

/// Compute a pure deterministic sell quote for returning `shares_in` of `side` into the pool.
///
/// Formula:
/// - Add `shares_in` to the sold outcome's reserve: `sold_after_in = sold_reserve + shares_in`
/// - Find maximum integer `r` (`1 <= r <= min(shares_in, other_reserve - 1)`) such that
///   `(sold_after_in - r) * (other_reserve - r) >= yes_reserve * no_reserve`
/// - Require both post-trade reserves `sold_after_in - r` and `other_reserve - r` in `1..=MAX_RESERVE`
/// - `fee = ceil(r * fee_bps / 10_000)`
/// - `net_collateral_out = r - fee`
pub fn quote_sell(
    yes_reserve: i128,
    no_reserve: i128,
    side: Outcome,
    shares_in: i128,
    fee_bps: u32,
) -> Result<Quote, QuoteError> {
    validate_reserves(yes_reserve, no_reserve)?;
    validate_input(shares_in)?;
    validate_fee_bps(fee_bps)?;

    let (sold_reserve, other_reserve) = match side {
        Outcome::Yes => (yes_reserve, no_reserve),
        Outcome::No => (no_reserve, yes_reserve),
    };

    if other_reserve <= MIN_RESERVE {
        return Err(QuoteError::InsufficientLiquidity);
    }

    let k = yes_reserve
        .checked_mul(no_reserve)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    let sold_after_in = sold_reserve
        .checked_add(shares_in)
        .ok_or(QuoteError::ArithmeticOverflow)?;

    let max_release_by_other = other_reserve
        .checked_sub(MIN_RESERVE)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    let hi_bound = shares_in.min(max_release_by_other);
    if hi_bound < 1 {
        return Err(QuoteError::ZeroOutput);
    }

    let mut lo: i128 = 1;
    let mut hi: i128 = hi_bound;
    let mut gross_released: i128 = 0;

    while lo <= hi {
        let mid = lo + (hi - lo) / 2;
        let cand_sold = sold_after_in
            .checked_sub(mid)
            .ok_or(QuoteError::ArithmeticOverflow)?;
        let cand_other = other_reserve
            .checked_sub(mid)
            .ok_or(QuoteError::ArithmeticOverflow)?;
        let prod = cand_sold
            .checked_mul(cand_other)
            .ok_or(QuoteError::ArithmeticOverflow)?;
        if prod >= k {
            gross_released = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    if gross_released <= 0 {
        return Err(QuoteError::ZeroOutput);
    }

    let next_sold = sold_after_in
        .checked_sub(gross_released)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    let next_other = other_reserve
        .checked_sub(gross_released)
        .ok_or(QuoteError::ArithmeticOverflow)?;

    if next_sold < MIN_RESERVE || next_other < MIN_RESERVE {
        return Err(QuoteError::InsufficientLiquidity);
    }
    if next_sold > MAX_RESERVE || next_other > MAX_RESERVE {
        return Err(QuoteError::ReserveOverflow);
    }

    let fee = ceil_fee(gross_released, fee_bps)?;
    let net_collateral_out = gross_released
        .checked_sub(fee)
        .ok_or(QuoteError::ArithmeticOverflow)?;
    if net_collateral_out <= 0 {
        return Err(QuoteError::ZeroOutput);
    }

    let (next_yes_reserve, next_no_reserve) = match side {
        Outcome::Yes => (next_sold, next_other),
        Outcome::No => (next_other, next_sold),
    };

    Ok(Quote {
        output: net_collateral_out,
        fee,
        next_yes_reserve,
        next_no_reserve,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_vector_yes_buy_and_sell_zero_fee() {
        // With reserves 100/100 and zero fee, a 10-unit YES buy returns 19 shares and leaves 91/110.
        let buy = quote_buy(100, 100, Outcome::Yes, 10, 0).unwrap();
        assert_eq!(
            buy,
            Quote {
                output: 19,
                fee: 0,
                next_yes_reserve: 91,
                next_no_reserve: 110,
            }
        );
        assert!(buy.next_yes_reserve * buy.next_no_reserve >= 100 * 100);

        // Selling those 19 shares against 91/110 returns 9 collateral and leaves 101/101.
        // A 10-unit release would make 100 * 100 = 10,000 < 91 * 110 = 10,010.
        let sell = quote_sell(
            buy.next_yes_reserve,
            buy.next_no_reserve,
            Outcome::Yes,
            buy.output,
            0,
        )
        .unwrap();
        assert_eq!(
            sell,
            Quote {
                output: 9,
                fee: 0,
                next_yes_reserve: 101,
                next_no_reserve: 101,
            }
        );
        assert!(
            sell.next_yes_reserve * sell.next_no_reserve
                >= buy.next_yes_reserve * buy.next_no_reserve
        );
    }

    #[test]
    fn mirrored_no_path_matches_yes_symmetry() {
        let buy_no = quote_buy(100, 100, Outcome::No, 10, 0).unwrap();
        assert_eq!(
            buy_no,
            Quote {
                output: 19,
                fee: 0,
                next_yes_reserve: 110,
                next_no_reserve: 91,
            }
        );

        let sell_no = quote_sell(
            buy_no.next_yes_reserve,
            buy_no.next_no_reserve,
            Outcome::No,
            buy_no.output,
            0,
        )
        .unwrap();
        assert_eq!(
            sell_no,
            Quote {
                output: 9,
                fee: 0,
                next_yes_reserve: 101,
                next_no_reserve: 101,
            }
        );

        // Asymmetric reserves mirror cleanly between YES and NO.
        let yes_asym = quote_buy(250 * SCALE, 400 * SCALE, Outcome::Yes, 25 * SCALE, 30).unwrap();
        let no_asym = quote_buy(400 * SCALE, 250 * SCALE, Outcome::No, 25 * SCALE, 30).unwrap();
        assert_eq!(yes_asym.output, no_asym.output);
        assert_eq!(yes_asym.fee, no_asym.fee);
        assert_eq!(yes_asym.next_yes_reserve, no_asym.next_no_reserve);
        assert_eq!(yes_asym.next_no_reserve, no_asym.next_yes_reserve);

        let sell_yes_asym = quote_sell(
            250 * SCALE,
            400 * SCALE,
            Outcome::Yes,
            30 * SCALE,
            DEFAULT_TEST_FEE_BPS,
        )
        .unwrap();
        let sell_no_asym = quote_sell(
            400 * SCALE,
            250 * SCALE,
            Outcome::No,
            30 * SCALE,
            DEFAULT_TEST_FEE_BPS,
        )
        .unwrap();
        assert_eq!(sell_yes_asym.output, sell_no_asym.output);
        assert_eq!(sell_yes_asym.fee, sell_no_asym.fee);
        assert_eq!(sell_yes_asym.next_yes_reserve, sell_no_asym.next_no_reserve);
        assert_eq!(sell_yes_asym.next_no_reserve, sell_no_asym.next_yes_reserve);
    }

    #[test]
    fn conservative_fee_rounding_with_30_bps_fixture() {
        // 1 base unit at 30 bps rounds fee up to 1, leaving 0 net input -> rejected.
        assert_eq!(ceil_fee(1, DEFAULT_TEST_FEE_BPS), Ok(1));
        assert_eq!(
            quote_buy(1000, 1000, Outcome::Yes, 1, DEFAULT_TEST_FEE_BPS),
            Err(QuoteError::ZeroNetInput)
        );

        // 10_000 base units at 30 bps: exact fee = 30.
        assert_eq!(ceil_fee(10_000, DEFAULT_TEST_FEE_BPS), Ok(30));
        // 10_001 base units at 30 bps: ceil(300_030 / 10_000) = 31.
        assert_eq!(ceil_fee(10_001, DEFAULT_TEST_FEE_BPS), Ok(31));

        // Seven-decimal fixture: 100 XLM / 100 XLM pool, buy 10 XLM YES at 30 bps.
        // gross = 100_000_000, fee = 300_000, net_input = 99_700_000.
        // k = 10^18, next_no = 1_099_700_000.
        // next_yes = ceil(10^18 / 1_099_700_000) = 909_338_911.
        // shares_out = 1_000_000_000 + 99_700_000 - 909_338_911 = 190_361_089.
        let pool = 100 * SCALE;
        let buy = quote_buy(pool, pool, Outcome::Yes, 10 * SCALE, DEFAULT_TEST_FEE_BPS).unwrap();
        assert_eq!(buy.fee, 300_000);
        assert_eq!(buy.next_no_reserve, 1_099_700_000);
        assert_eq!(buy.next_yes_reserve, 909_338_911);
        assert_eq!(buy.output, 190_361_089);

        // Selling those 190_361_089 YES shares back at 30 bps:
        // Pre-sell k = 909_338_911 * 1_099_700_000 = 1_000_000_000_426_700_000.
        // Sold reserve after input = 909_338_911 + 190_361_089 = 1_099_700_000.
        // Max gross release r = 99_699_999 (since 1_000_000_001^2 > k, while 1_000_000_000^2 < k).
        // Sell fee = ceil(99_699_999 * 30 / 10_000) = 299_100.
        // Net collateral out = 99_699_999 - 299_100 = 99_400_899.
        let sell = quote_sell(
            buy.next_yes_reserve,
            buy.next_no_reserve,
            Outcome::Yes,
            buy.output,
            DEFAULT_TEST_FEE_BPS,
        )
        .unwrap();
        assert_eq!(sell.fee, 299_100);
        assert_eq!(sell.output, 99_400_899);
        assert_eq!(sell.next_yes_reserve, 1_000_000_001);
        assert_eq!(sell.next_no_reserve, 1_000_000_001);
    }

    #[test]
    fn reject_invalid_reserves_inputs_fees_and_bounds() {
        assert_eq!(
            quote_buy(0, 100, Outcome::Yes, 10, 0),
            Err(QuoteError::InvalidReserve)
        );
        assert_eq!(
            quote_buy(100, -1, Outcome::Yes, 10, 0),
            Err(QuoteError::InvalidReserve)
        );
        assert_eq!(
            quote_buy(MAX_RESERVE + 1, 100, Outcome::Yes, 10, 0),
            Err(QuoteError::InvalidReserve)
        );
        assert_eq!(
            quote_buy(100, 100, Outcome::Yes, 0, 0),
            Err(QuoteError::InvalidInput)
        );
        assert_eq!(
            quote_buy(100, 100, Outcome::Yes, MAX_RESERVE + 1, 0),
            Err(QuoteError::InvalidInput)
        );
        assert_eq!(
            quote_buy(100, 100, Outcome::Yes, 10, MAX_FEE_BPS + 1),
            Err(QuoteError::InvalidFeeBps)
        );
        assert_eq!(
            quote_sell(100, 100, Outcome::Yes, 10, MAX_FEE_BPS + 1),
            Err(QuoteError::InvalidFeeBps)
        );

        // Post-trade reserve exceeding MAX_RESERVE is rejected.
        assert_eq!(
            quote_buy(100, MAX_RESERVE, Outcome::Yes, 10, 0),
            Err(QuoteError::ReserveOverflow)
        );
        assert_eq!(
            quote_sell(MAX_RESERVE, 100, Outcome::Yes, 50, 0),
            Err(QuoteError::ReserveOverflow)
        );

        // Single-unit opposite reserve cannot release a whole complete set without hitting 0.
        assert_eq!(
            quote_sell(100, 1, Outcome::Yes, 50, 0),
            Err(QuoteError::InsufficientLiquidity)
        );

        // Tiny sell that cannot release even 1 complete set returns ZeroOutput.
        assert_eq!(
            quote_sell(100, 100, Outcome::Yes, 1, 0),
            Err(QuoteError::ZeroOutput)
        );
    }

    #[test]
    fn quote_invariants_across_deterministic_grid() {
        let reserves = [100i128, 1_000, 10 * SCALE, 50_000 * SCALE];
        let inputs = [10i128, 250, SCALE, 500 * SCALE];
        let fees = [0u32, 30, 100, 1_000];

        for &y in &reserves {
            for &n in &reserves {
                let k_before = y * n;
                for &inp in &inputs {
                    for &bps in &fees {
                        for side in [Outcome::Yes, Outcome::No] {
                            if let Ok(q) = quote_buy(y, n, side, inp, bps) {
                                assert!(q.output > 0);
                                assert!(q.fee >= 0 && q.fee < inp);
                                assert!(q.next_yes_reserve >= MIN_RESERVE && q.next_yes_reserve <= MAX_RESERVE);
                                assert!(q.next_no_reserve >= MIN_RESERVE && q.next_no_reserve <= MAX_RESERVE);
                                let k_after = q.next_yes_reserve * q.next_no_reserve;
                                assert!(k_after >= k_before);

                                // Round-trip sell must never extract more collateral than originally paid in.
                                if let Ok(s) = quote_sell(
                                    q.next_yes_reserve,
                                    q.next_no_reserve,
                                    side,
                                    q.output,
                                    bps,
                                ) {
                                    assert!(s.output < inp);
                                    assert!(
                                        s.next_yes_reserve * s.next_no_reserve >= k_after
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
