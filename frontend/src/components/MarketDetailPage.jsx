import {useEffect, useState} from 'react';
import {Link, useLocation, useParams} from 'react-router-dom';
import {formatAmount} from '../../../shared/amount.mjs';
import {marketSlug} from '../lib/market-path.mjs';
import {fetchPriceCandles} from '../lib/market-data.mjs';
import MarketAvatar from './MarketAvatar.jsx';
import MiniChart from './MiniChart.jsx';

const chartRanges = {
  day: {label: '24H', seconds: 86_400, granularity: 300},
  week: {label: '7D', seconds: 604_800, granularity: 3_600},
  month: {label: '30D', seconds: 2_592_000, granularity: 21_600},
};

export default function MarketDetailPage({markets, positions, busy, now, previewMode, onPredict, onClaim, onRequest}) {
  const {slug} = useParams();
  const location = useLocation();
  const [side, setSide] = useState(() => {
    const value = new URLSearchParams(location.search).get('side');
    return value === '0' || value === '1' ? Number(value) : 0;
  });
  const [amount, setAmount] = useState('1');
  const [range, setRange] = useState('week');
  const [priceSeries, setPriceSeries] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState('');
  const marketId = Number(location.hash.slice(1));
  const market = markets.find(item => Number(item.id) === marketId) || markets.find(item => marketSlug(item.question) === slug);

  useEffect(() => {
    const value = new URLSearchParams(location.search).get('side');
    setSide(value === '0' || value === '1' ? Number(value) : 0);
  }, [location.search, marketId]);

  useEffect(() => {
    if (market?.kind !== 'Price') {
      setPriceSeries(null);
      setChartError('');
      return;
    }
    const controller = new AbortController();
    let active = true;
    const load = async () => {
      setChartLoading(true);
      try {
        const series = await fetchPriceCandles(market.asset, {signal: controller.signal, granularity: chartRanges[range].granularity});
        if (active) {setPriceSeries(series); setChartError('');}
      } catch (error) {
        if (active && error.name !== 'AbortError') setChartError(error.message || 'Price chart is unavailable.');
      } finally {
        if (active) setChartLoading(false);
      }
    };
    load();
    const refresh = setInterval(load, 60_000);
    return () => {active = false; controller.abort(); clearInterval(refresh);};
  }, [market?.id, market?.kind, market?.asset, range]);

  if (!market) return <section className="page-state"><p className="eyebrow">MARKET NOT FOUND</p><h1>This market is unavailable</h1><p>It may have been removed or is not in the currently loaded markets.</p><Link className="button button-secondary" to="/markets">Back to markets</Link></section>;

  const position = positions[market.id];
  const closed = now >= Number(market.closes_at);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const canClaim = position && !position.claimed && (market.status === 3 || timedOut || market.status === 2 && position.side === market.outcome);
  const status = timedOut ? 'Refundable' : closed && market.status === 0 ? 'Closed' : ['Open', 'Resolution requested', 'Settled', 'Refundable'][market.status];
  const totalPool = BigInt(market.yes_pool) + BigInt(market.no_pool);
  const yesShare = totalPool > 0n ? Number(BigInt(market.yes_pool) * 10000n / totalPool) / 100 : 50;
  const noShare = 100 - yesShare;
  const canPredict = !previewMode && !closed && market.status === 0 && !position;
  const displayedCandles = priceSeries?.candles.filter(candle => candle.time >= Date.now() - chartRanges[range].seconds * 1000) || [];

  return <div className="market-detail-page">
    <Link className="back-link" to="/markets">← All markets</Link>
    <header className="detail-heading"><div className="detail-title-group"><MarketAvatar market={market} size="large" /><div><p className="eyebrow">{market.kind === 'Price' ? `${market.asset} PRICE MARKET` : 'EVENT MARKET'} · #{market.id}</p><h1>{market.question}</h1><p className="detail-meta"><span className="status-pill">{status}</span><span>Closes {new Date(Number(market.closes_at) * 1000).toLocaleString()}</span></p></div></div><button className="button button-secondary" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy link</button></header>
    <div className="detail-layout">
      <div className="detail-main-column">
        <section className="detail-chart-panel">
          <div className="detail-section-heading"><div><p className="eyebrow">{market.kind === 'Price' ? 'LIVE PRICE HISTORY' : 'LIVE CONTRACT DATA'}</p><h2>{market.kind === 'Price' ? `${market.asset}/USD` : 'Pool distribution'}</h2></div>
            {market.kind === 'Price' ? <div className="chart-range-controls" role="group" aria-label="Chart date range">{Object.entries(chartRanges).map(([id, value]) => <button key={id} type="button" className={range === id ? 'is-active' : ''} aria-pressed={range === id} onClick={() => setRange(id)}>{value.label}</button>)}</div> : <span className="detail-period">On-chain</span>}
          </div>
          {market.kind === 'Price' ? chartLoading && !displayedCandles.length ? <div className="detail-chart-empty" role="status">Loading live Coinbase candles…</div> : chartError ? <div className="detail-chart-empty" role="status">{chartError}</div> : displayedCandles.length > 1 ? <MiniChart candles={displayedCandles} asset={market.asset} source={priceSeries.source} granularity={priceSeries.granularity} periodLabel={chartRanges[range].label} /> : <div className="detail-chart-empty" role="status">Not enough live candle data for this range.</div> : <><div className="probability-bar" role="img" aria-label={`YES pool share ${yesShare} percent, NO pool share ${noShare} percent`}><span style={{width: `${yesShare}%`}} /></div><div className="probability-labels"><span>YES pool share <strong>{yesShare.toFixed(2)}%</strong></span><span>NO pool share <strong>{noShare.toFixed(2)}%</strong></span></div><p className="chart-onchain-note">Computed from the current on-chain YES and NO pools.</p></>}
        </section>
        <section className="detail-panel"><p className="eyebrow">ABOUT THIS MARKET</p><h2>Resolution and timing</h2><p>{market.kind === 'Price' ? 'This price market resolves from the first supported observation after close. The resolver compares the observed USD price with the market target.' : 'This event market is resolved by the configured operator using the evidence policy for the question.'}</p><div className="detail-facts"><div><span>Market ID</span><strong>#{market.id}</strong></div><div><span>Closes</span><strong>{new Date(Number(market.closes_at) * 1000).toLocaleString()}</strong></div><div><span>Resolution deadline</span><strong>{new Date(Number(market.deadline) * 1000).toLocaleString()}</strong></div><div><span>Network</span><strong>Stellar Testnet</strong></div></div></section>
      </div>
      <aside className="detail-trade-column">
        <section className="trade-panel"><div className="detail-section-heading"><div><p className="eyebrow">CURRENT POOLS</p><h2>Market liquidity</h2></div></div><div className="trade-outcome yes-outcome"><span>YES</span><strong>{formatAmount(market.yes_pool)} XLM</strong></div><div className="trade-outcome no-outcome"><span>NO</span><strong>{formatAmount(market.no_pool)} XLM</strong></div>
          {position && <p className="position-note">Your position: <strong>{position.side === 0 ? 'YES' : 'NO'}</strong> · {formatAmount(position.amount)} XLM</p>}
          {canPredict && <form className="detail-trade-form" onSubmit={event => {event.preventDefault(); onPredict(market.id, side, amount);}}><div className="segmented-control" aria-label="Choose a side"><button type="button" className={side === 0 ? 'is-selected yes-selected' : ''} aria-pressed={side === 0} onClick={() => setSide(0)}>Buy YES</button><button type="button" className={side === 1 ? 'is-selected no-selected' : ''} aria-pressed={side === 1} onClick={() => setSide(1)}>Buy NO</button></div><label className="amount-input">Stake <span>XLM</span><input required inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} /></label><button className="button button-primary market-submit" disabled={busy}>Place position</button></form>}
          {previewMode && <p className="preview-note">Sample market data · trading is read-only</p>}
          {closed && !timedOut && market.status === 0 && <button className="button button-secondary market-submit" disabled={busy || previewMode} onClick={() => onRequest(market.id)}>Request resolution</button>}
          {canClaim && <button className="button button-primary market-submit" disabled={busy || previewMode} onClick={() => onClaim(market.id)}>{timedOut || market.status === 3 ? 'Claim refund' : 'Claim winnings'}</button>}
        </section>
        <section className="detail-panel"><p className="eyebrow">YOUR MARKET</p><h2>Keep track</h2><p>Positions are tied to the connected Stellar address. Sign in with Privy for your RevMarket account, or connect Freighter to authorize Stellar transactions.</p><Link className="market-card-cta" to="/profile">View profile <span aria-hidden="true">→</span></Link></section>
      </aside>
    </div>
  </div>;
}