import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {formatAmount} from '../../../shared/amount.mjs';
import MarketAvatar from './MarketAvatar.jsx';
import {marketPath} from '../lib/market-path.mjs';

function shortAddress(addr) {
  if (!addr) return 'User';
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 4)}…${addr.slice(-4)}`;
}

export default function MarketCard({market, position, now, previewMode, variant = 'regular'}) {
  const navigate = useNavigate();
  const [side, setSide] = useState(position?.side ?? null);
  useEffect(() => setSide(position?.side ?? null), [market.id, position?.side]);
  const closed = now >= Number(market.closes_at);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const status = timedOut ? 'Refundable' : closed && market.status === 0 ? 'Closed' : ['Open', 'Resolution requested', 'Settled', 'Refundable'][market.status];
  const selectable = !closed && market.status === 0 && !timedOut && !position;

  const isLive = variant === 'live';

  const handleCardClick = (e) => {
    // If it's a live card or click originated from interactive buttons, don't navigate
    if (isLive || e.target.closest('button')) return;
    navigate(marketPath(market, side));
  };

  // Extract optional bracketed category, e.g. "[Sports] Will Arsenal win..."
  const categoryMatch = market.question.match(/^\[(.*?)\]\s*(.*)$/);
  const displayCategory = categoryMatch ? categoryMatch[1] : (market.kind === 'Price' ? `${market.asset} price` : 'Event');
  const displayQuestion = categoryMatch ? categoryMatch[2] : market.question;

  // Calculate market volume / liquidity
  const totalVolume = BigInt(market.yes_pool || 0) + BigInt(market.no_pool || 0);

  // Format activity details: buyer address and compact relative time
  const activityBuyer = market.latest_activity?.user ? shortAddress(market.latest_activity.user) : (market.creator ? shortAddress(market.creator) : 'Trader');
  const activityTime = market.latest_activity?.timeAgo || '4s ago';

  return (
    <article
      className={`market-card${isLive ? ' market-card-live is-unclickable' : ' is-card-clickable'}`}
      onClick={handleCardClick}
      role={isLive ? 'article' : 'button'}
      tabIndex={isLive ? -1 : 0}
      onKeyDown={(e) => {
        if (!isLive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          handleCardClick(e);
        }
      }}
      aria-label={`Market: ${displayQuestion}`}
    >
      <div className="market-card-top">
        <MarketAvatar market={market} size={isLive ? 'large' : 'regular'} />
        <span className={`status-pill${market.status === 0 && !closed ? ' status-ready' : ''}`}>{status}</span>
      </div>

      <div className="market-card-body">
        <div className="market-category-row">
          <p className="market-category">
            {displayCategory} <span>· #{market.id}</span>
          </p>
          {!isLive && (
            <span className="market-volume-badge" title="Total Volume">
              Vol {formatAmount(totalVolume)} XLM
            </span>
          )}
        </div>

        <h2 title={displayQuestion}>{displayQuestion}</h2>

        <p className="market-close">Closes {new Date(Number(market.closes_at) * 1000).toLocaleString()}</p>
      </div>

      {isLive && (
        <div className="live-card-stats">
          <div className="live-card-price-row">
            <span className="live-price-headline">
              {(() => {
                if (totalVolume === 0n) return '50¢';
                const pct = Number((BigInt(market.yes_pool || 0) * 100n) / totalVolume);
                return `${pct}¢`;
              })()}
            </span>
            <span className="live-price-sublabel">YES PRICE</span>
          </div>

          <div className="live-card-activity-row">
            <span className="live-pulse-dot" />
            <span className="live-activity-text">
              <strong className="live-activity-strong">{activityBuyer}</strong> · {activityTime}
            </span>
          </div>
        </div>
      )}

      {!isLive && (
        <div className="market-card-trade-options" aria-label="Choose an outcome">
          <button
            type="button"
            className={`outcome-choice outcome-choice-yes${side === 0 ? ' is-selected' : ''}`}
            aria-pressed={side === 0}
            disabled={!selectable && side !== 0}
            onClick={(e) => {
              e.stopPropagation();
              navigate(marketPath(market, 0));
            }}
          >
            YES
          </button>
          <button
            type="button"
            className={`outcome-choice outcome-choice-no${side === 1 ? ' is-selected' : ''}`}
            aria-pressed={side === 1}
            disabled={!selectable && side !== 1}
            onClick={(e) => {
              e.stopPropagation();
              navigate(marketPath(market, 1));
            }}
          >
            NO
          </button>
        </div>
      )}
    </article>
  );
}
