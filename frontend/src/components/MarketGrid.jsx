import {useRef} from 'react';
import MarketCard from './MarketCard.jsx';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

function LiveMarketRow({markets, positions, now, previewMode}) {
  const railRef = useRef(null);
  const liveMarkets = markets.filter(market => market.status === 0 && now < Number(market.closes_at) && now <= Number(market.deadline));

  return <section className="live-market-section" aria-labelledby="live-markets-title">
    <div className="live-market-heading"><div><p className="eyebrow">OPEN ON STELLAR TESTNET</p><h2 id="live-markets-title">Live markets</h2></div><div className="live-market-controls"><span>{liveMarkets.length} open</span><button className="icon-button" title="Scroll live markets left" aria-label="Scroll live markets left" onClick={() => railRef.current?.scrollBy({left: -288, behavior: 'smooth'})}><PhosphorIcon name="arrowLeft" /></button><button className="icon-button" title="Scroll live markets right" aria-label="Scroll live markets right" onClick={() => railRef.current?.scrollBy({left: 288, behavior: 'smooth'})}><PhosphorIcon name="arrowRight" /></button></div></div>
    {liveMarkets.length ? <div className="live-market-rail" ref={railRef} aria-label="Horizontally scrolling live markets">{liveMarkets.map(market => <MarketCard key={market.id} market={market} position={positions[market.id]} now={now} previewMode={previewMode} variant="live" />)}</div> : <div className="live-market-empty">No open on-chain markets are available right now.</div>}
  </section>;
}

export default function MarketGrid({markets, positions, now, previewMode, showLiveRow = false}) {
  return <>
    {showLiveRow && <LiveMarketRow markets={markets} positions={positions} now={now} previewMode={previewMode} />}
    {markets.length ? <section className="market-grid" aria-label="All prediction markets">{markets.map(market => <MarketCard key={market.id} market={market} position={positions[market.id]} now={now} previewMode={previewMode} />)}</section> : <div className="empty-state market-empty"><strong>No markets found</strong><p>There are no on-chain markets matching this view.</p></div>}
  </>;
}