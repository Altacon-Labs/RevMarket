import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {formatAmount} from '../../../shared/amount.mjs';
import MarketAvatar from './MarketAvatar.jsx';
import {marketPath} from '../lib/market-path.mjs';

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
      aria-label={`Market: ${market.question}`}
    >
      <div className="market-card-top">
        <MarketAvatar market={market} size={isLive ? 'large' : 'regular'} />
        <span className={`status-pill${market.status === 0 && !closed ? ' status-ready' : ''}`}>{status}</span>
      </div>

      <div className="market-card-body">
        <p className="market-category">
          {market.kind === 'Price' ? `${market.asset} price` : 'Event market'} <span>· #{market.id}</span>
        </p>

        <h2 title={market.question}>{market.question}</h2>

        <p className="market-close">Closes {new Date(Number(market.closes_at) * 1000).toLocaleString()}</p>
      </div>

      {isLive && (
        <div className="live-card-stats">
          <div className="live-card-price-row">
            <span className="live-price-headline">
              {(() => {
                const total = BigInt(market.yes_pool || 0) + BigInt(market.no_pool || 0);
                if (total === 0n) return '50¢';
                const pct = Number((BigInt(market.yes_pool || 0) * 100n) / total);
                return `${pct}¢`;
              })()}
            </span>
            <span className="live-price-sublabel">YES PRICE</span>
          </div>

          <div className="live-card-activity-row">
            <span className="live-pulse-dot" />
            <span className="live-activity-text">
              {market.latest_activity ? (
                <>
                  <strong className="live-activity-strong">{market.latest_activity.action}</strong> {market.latest_activity.amount} · {market.latest_activity.timeAgo}
                </>
              ) : (
                'Recent prediction activity active'
              )}
            </span>
          </div>
        </div>
      )}

      {!isLive && (
        <div className="market-card-trade-options" aria-label="Choose an outcome" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`outcome-choice outcome-choice-yes${side === 0 ? ' is-selected' : ''}`}
            aria-pressed={side === 0}
            disabled={!selectable && side !== 0}
            onClick={() => setSide(0)}
          >
            YES
          </button>
          <button
            type="button"
            className={`outcome-choice outcome-choice-no${side === 1 ? ' is-selected' : ''}`}
            aria-pressed={side === 1}
            disabled={!selectable && side !== 1}
            onClick={() => setSide(1)}
          >
            NO
          </button>
        </div>
      )}
    </article>
  );
}
