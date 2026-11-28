// Wallet position discovery beyond the 50-market home-page window (issue #78).
// Uses the backend's verified activity index (confirmed on-chain prediction
// events) to find every market the wallet ever predicted in, then the caller
// confirms each position against the current contract.

export const DISCOVERY_MAX_PAGES = 20;
export const DISCOVERY_PAGE_LIMIT = 100;

/**
 * Paginate /api/activity/verified?eventType=prediction and collect the unique
 * market IDs the wallet has predicted in, plus indexer freshness signals.
 *
 * @param {Function} request  injected api() (or a test double)
 * @param {number}  maxPages  pagination safety cap
 * @returns {Promise<{marketIds: Set<number>, hasGaps: boolean, fresh: boolean, unavailable: boolean, pages: number}>}
 */
export async function discoverWalletMarketIds(request, {maxPages = DISCOVERY_MAX_PAGES} = {}) {
  const marketIds = new Set();
  let hasGaps = false;
  let fresh = true;
  let unavailable = false;
  let pages = 0;
  let cursor = null;
  try {
    do {
      const qs = `eventType=prediction&limit=${DISCOVERY_PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await request(`/activity/verified?${qs}`);
      for (const item of page?.items ?? []) {
        if (typeof item?.marketId === 'number' && Number.isSafeInteger(item.marketId) && item.marketId >= 0) {
          marketIds.add(item.marketId);
        }
      }
      if (page?.freshness) {
        if (page.freshness.hasGaps) hasGaps = true;
        if (!page.freshness.fresh) fresh = false;
      }
      cursor = page?.pageInfo?.hasMore ? page.nextCursor : null;
      pages++;
    } while (cursor && pages < maxPages);
  } catch {
    // Backend offline or no activity session — degrade; caller shows partial coverage.
    unavailable = true;
    fresh = false;
  }
  return {marketIds, hasGaps, fresh, unavailable, pages: pages || (unavailable ? 0 : pages)};
}

/**
 * Which discovered market IDs fall outside the already-loaded home-page window.
 */
export function computeExtraMarketIds(discoveredIds, windowStart) {
  const start = Math.max(0, Number(windowStart) || 0);
  return [...discoveredIds].filter(id => Number.isSafeInteger(id) && id >= 0 && id < start).sort((a, b) => a - b);
}

/**
 * An unknown position must never be shown as a zero balance: only positions the
 * contract confirms with a positive amount qualify.
 */
export function hasOpenAmount(position) {
  return Boolean(position) && typeof position.amount !== 'undefined' && BigInt(position.amount) > 0n;
}

/**
 * Coverage disclosure derived from discovery signals.
 */
export function describeCoverage({fresh, hasGaps, unavailable, extraCount}) {
  if (unavailable) {
    return {
      complete: false,
      hasGaps: false,
      unavailable: true,
      extraCount: extraCount || 0,
      message: 'Position history is unavailable; older markets beyond the latest 50 may not be visible.',
    };
  }
  if (hasGaps) {
    return {
      complete: false,
      hasGaps: true,
      unavailable: false,
      extraCount: extraCount || 0,
      message: 'Position history may be incomplete — the activity indexer has gaps. Some older positions could be missing.',
    };
  }
  if (!fresh) {
    return {
      complete: false,
      hasGaps: false,
      unavailable: false,
      extraCount: extraCount || 0,
      message: 'Scanning older markets for your positions; coverage may be partial.',
    };
  }
  return {complete: true, hasGaps: false, unavailable: false, extraCount: extraCount || 0, message: null};
}
