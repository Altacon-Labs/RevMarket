import {useEffect, useState} from 'react';
import {Link} from 'react-router-dom';
import {formatAmount} from '../../../shared/amount.mjs';
import MarketAvatar from './MarketAvatar.jsx';
import {marketPath} from '../lib/market-path.mjs';

export default function MarketCard({market, position, now, previewMode, variant = 'regular'}) {
  const [side, setSide] = useState(position?.side ?? null);
  useEffect(() => setSide(position?.side ?? null), [market.id, position?.side]);
  const closed = now >= Number(market.closes_at);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const status = timedOut ? 'Refundable' : closed && market.status === 0 ? 'Closed' : ['Open', 'Resolution requested', 'Settled', 'Refundable'][market.status];
  const selectable = !closed && market.status === 0 && !timedOut && !position;
  const detailsPath = marketPath(market, side);

  return <article className={`market-card${variant === 'live' ? ' market-card-live' : ''}`}>
    <Link className="market-card-link" to={marketPath(market)} aria-label={`View market: ${market.question}`}>
      <div className="market-card-top"><MarketAvatar market={market} size={variant === 'live' ? 'large' : 'regular'} /><span className={`status-pill${market.status === 0 && !closed ? ' status-ready' : ''}`}>{status}</span></div>
      <p className="market-category">{market.kind === 'Price' ? `${market.asset} price` : 'Event market'} <span>· #{market.id}</span></p>
      <h2>{market.question}</h2>
      <p className="market-close">Closes {new Date(Number(market.closes_at) * 1000).toLocaleString()}</p>
      <div className="market-pools"><div><small>YES pool</small><strong>{formatAmount(market.yes_pool)} XLM</strong></div><div><small>NO pool</small><strong>{formatAmount(market.no_pool)} XLM</strong></div></div>
    </Link>
    <div className="market-card-trade-options" aria-label="Choose an outcome">
      <button type="button" className={`outcome-choice outcome-choice-yes${side === 0 ? ' is-selected' : ''}`} aria-pressed={side === 0} disabled={!selectable && side !== 0} onClick={() => setSide(0)}>YES</button>
      <button type="button" className={`outcome-choice outcome-choice-no${side === 1 ? ' is-selected' : ''}`} aria-pressed={side === 1} disabled={!selectable && side !== 1} onClick={() => setSide(1)}>NO</button>
    </div>
    <div className="market-card-footer">
      {previewMode && <span className="preview-note">Read-only</span>}
      <Link className="market-card-cta" to={detailsPath}>{side === 0 ? 'Continue YES' : side === 1 ? 'Continue NO' : 'Market details'} <span aria-hidden="true">→</span></Link>
    </div>
  </article>;
}