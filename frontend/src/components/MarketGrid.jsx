import {useRef} from 'react';
import MarketCard from './MarketCard.jsx';
import SkeletonCard from './SkeletonCard.jsx';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

function LiveMarketRow({markets, positions, now, previewMode, loading}) {
  const liveMarkets = markets.filter(market => market.status === 0 && now < Number(market.closes_at) && now <= Number(market.deadline));
  // Create an extended repeated list to support a continuous, seamless sliding marquee
  const sliderMarkets = liveMarkets.length > 0 
    ? [...liveMarkets, ...liveMarkets, ...liveMarkets, ...liveMarkets]
    : [];

  return <section className="live-market-section" aria-labelledby="live-markets-title">
    <div className="live-market-heading">
      <div>
        <p className="eyebrow">CURRENTLY OPEN</p>
        <h2 id="live-markets-title">Live markets</h2>
      </div>
      <div className="live-market-controls">
        <span>{loading ? 'Loading…' : `${liveMarkets.length} active`}</span>
      </div>
    </div>
    {loading ? (
      <div className="live-market-rail">
        <SkeletonCard variant="live" />
        <SkeletonCard variant="live" />
        <SkeletonCard variant="live" />
      </div>
    ) : sliderMarkets.length ? (
      <div className="live-marquee-container" aria-label="Constantly sliding live markets marquee">
        <div className="live-marquee-track">
          {sliderMarkets.map((market, idx) => (
            <MarketCard
              key={`${market.id}-${idx}`}
              market={market}
              position={positions[market.id]}
              now={now}
              previewMode={previewMode}
              variant="live"
            />
          ))}
        </div>
      </div>
    ) : (
      <div className="live-market-empty">No open on-chain markets are available right now.</div>
    )}
  </section>;
}

export default function MarketGrid({
  markets,
  positions,
  now,
  previewMode,
  loading = false,
  showLiveRow = false,
  search = '',
  onSearch = null,
  activeFilter = 'all',
  onFilterChange = null
}) {
  return <>
    {showLiveRow && <LiveMarketRow markets={markets} positions={positions} now={now} previewMode={previewMode} loading={loading} />}

    <div className="market-search-row" role="search" aria-label="Search prediction markets">
      <div className="market-full-search-box">
        <PhosphorIcon name="search" size={20} />
        <input
          type="search"
          placeholder="Search markets by topic, event, or asset..."
          value={search}
          onChange={e => onSearch?.(e.target.value)}
          aria-label="Search markets"
        />
        {search && (
          <button
            type="button"
            className="search-clear"
            title="Clear search"
            aria-label="Clear search"
            onClick={() => onSearch?.('')}
          >
            ×
          </button>
        )}
      </div>

      <div className="market-filter-dropdown-wrap">
        <button
          type="button"
          className="button button-secondary market-filter-button"
          title="Filter markets"
          aria-label="Filter markets"
          onClick={() => {
            const next = activeFilter === 'all' ? 'price' : activeFilter === 'price' ? 'event' : 'all';
            onFilterChange?.(next);
          }}
        >
          <PhosphorIcon name="funnel" size={18} />
          <span className="filter-label">
            {activeFilter === 'all' ? 'All' : activeFilter === 'price' ? 'Price' : 'Event'}
          </span>
        </button>
      </div>
    </div>

    {loading ? (
      <section className="market-grid" aria-label="Loading markets">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </section>
    ) : markets.length ? (
      <section className="market-grid" aria-label="All prediction markets">
        {markets.map(market => <MarketCard key={market.id} market={market} position={positions[market.id]} now={now} previewMode={previewMode} />)}
      </section>
    ) : (
      <div className="empty-state market-empty"><strong>No markets found</strong><p>There are no on-chain markets matching this view.</p></div>
    )}
  </>;
}
