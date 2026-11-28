import {useEffect, useRef, useState} from 'react';
import {Link, useLocation} from 'react-router-dom';
import {formatAmount} from '../../../shared/amount.mjs';
import {loadMarketDetail, parseMarketId, parseMarketSide} from '../lib/market-path.mjs';
import {fetchPriceCandles} from '../lib/market-data.mjs';
import MarketAvatar from './MarketAvatar.jsx';
import MiniChart from './MiniChart.jsx';
import SettlementEvidence from './SettlementEvidence.jsx';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

const chartRanges = {
  day: {label: '24H', seconds: 86_400, granularity: 300},
  week: {label: '7D', seconds: 604_800, granularity: 3_600},
  month: {label: '30D', seconds: 2_592_000, granularity: 21_600},
};

export default function MarketDetailPage({
  markets,
  positions,
  address,
  source,
  client,
  contractId,
  loading = false,
  authenticated,
  onConnect,
  onLogin,
  busy,
  now,
  previewMode,
  onPredict,
  onClaim,
  onRequest,
  onRefreshMarket,
}) {
  const location = useLocation();
  const parsedId = parseMarketId(location.hash);
  const marketId = parsedId.valid ? parsedId.id : null;
  const loadedMarket = parsedId.valid ? markets.find(item => Number(item.id) === marketId) || null : null;
  const [side, setSide] = useState(() => parseMarketSide(location.search));
  const [amount, setAmount] = useState('10');
  const [submitError, setSubmitError] = useState('');
  const [range, setRange] = useState('week');
  const [priceSeries, setPriceSeries] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartError, setChartError] = useState('');
  const [directState, setDirectState] = useState({
    key: '',
    status: 'idle',
    market: null,
    position: null,
    error: '',
  });
  const [retryCount, setRetryCount] = useState(0);
  const requestSeq = useRef(0);

  useEffect(() => {
    setSide(parseMarketSide(location.search));
  }, [location.search, location.hash]);

  const requestKey = `${location.hash}|${address || ''}|${source || ''}`;
  const market = loadedMarket || (directState.key === requestKey ? directState.market : null);
  const hasLoadedPosition = parsedId.valid && Boolean(address) && Object.prototype.hasOwnProperty.call(positions, marketId);
  const position = parsedId.valid
    ? hasLoadedPosition
      ? positions[marketId]
      : directState.key === requestKey
        ? directState.position
        : null
    : null;

  useEffect(() => {
    if (!parsedId.valid) {
      requestSeq.current += 1;
      setDirectState({
        key: requestKey,
        status: 'missing',
        market: null,
        position: null,
        error: parsedId.reason === 'missing' ? 'Market identifier is missing from the link.' : 'Market identifier is invalid or out of range.',
      });
      return;
    }

    const needsMarket = !loadedMarket;
    const needsPosition = Boolean(address) && !hasLoadedPosition && Boolean(client) && Boolean(source);
    if (!needsMarket && !needsPosition) {
      requestSeq.current += 1;
      setDirectState({
        key: requestKey,
        status: 'ready',
        market: loadedMarket,
        position: hasLoadedPosition ? positions[marketId] : null,
        error: '',
      });
      return;
    }

    if (needsMarket && loading && (!client || !source)) {
      return;
    }

    let active = true;
    const seq = ++requestSeq.current;
    setDirectState(prev => ({
      key: requestKey,
      status: 'loading',
      market: loadedMarket || (prev.key === requestKey ? prev.market : null),
      position: null,
      error: '',
    }));

    loadMarketDetail({
      hash: location.hash,
      markets,
      positions,
      client,
      source,
      address,
      isCurrent: () => active && requestSeq.current === seq,
    }).then(result => {
      if (!active || requestSeq.current !== seq || !result.committed) return;
      setDirectState({
        key: requestKey,
        status: result.status,
        market: result.market,
        position: result.position,
        error: result.error || '',
      });
    });

    return () => {
      active = false;
    };
  }, [location.hash, requestKey, parsedId.valid, parsedId.reason, marketId, loadedMarket, hasLoadedPosition, address, source, client, loading, retryCount]);

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

  if (!parsedId.valid) {
    return (
      <section className="page-state" role="status">
        <p className="eyebrow">MARKET NOT FOUND</p>
        <h1>Invalid or missing market link</h1>
        <p>{parsedId.reason === 'missing' ? 'This link is missing a market identifier (#id).' : 'The market identifier in this link is malformed or out of range.'}</p>
        <Link className="button button-secondary" to="/markets">Back to markets</Link>
      </section>
    );
  }

  const isFetchingDirect = !market && (loading || directState.key !== requestKey || directState.status === 'loading');
  if (isFetchingDirect) {
    return (
      <section className="page-state" role="status">
        <p className="eyebrow">LOADING MARKET</p>
        <h1>Loading market #{marketId}</h1>
        <p>Fetching market details from Stellar Testnet.</p>
      </section>
    );
  }

  if (!market && directState.status === 'error') {
    return (
      <section className="page-state" role="alert">
        <p className="eyebrow">RPC UNAVAILABLE</p>
        <h1>Could not load market #{marketId}</h1>
        <p>{directState.error || 'The Stellar RPC request failed while reading this market.'}</p>
        <div className="detail-meta">
          <button type="button" className="button button-primary" onClick={() => setRetryCount(c => c + 1)}>Retry</button>
          <Link className="button button-secondary" to="/markets">Back to markets</Link>
        </div>
      </section>
    );
  }

  if (!market) {
    return (
      <section className="page-state" role="status">
        <p className="eyebrow">MARKET NOT FOUND</p>
        <h1>This market is unavailable</h1>
        <p>{directState.error || 'It may have been removed or does not exist on the contract.'}</p>
        <Link className="button button-secondary" to="/markets">Back to markets</Link>
      </section>
    );
  }
  const closed = now >= Number(market.closes_at);
  const timedOut = now > Number(market.deadline) && market.status < 2;
  const canClaim = position && !position.claimed && (market.status === 3 || timedOut || (market.status === 2 && position.side === market.outcome));
  const status = timedOut ? 'Refundable' : closed && market.status === 0 ? 'Closed' : ['Open', 'Resolution requested', 'Settled', 'Refundable'][market.status];
  const totalPool = BigInt(market.yes_pool) + BigInt(market.no_pool);
  const yesShare = totalPool > 0n ? Number(BigInt(market.yes_pool) * 10000n / totalPool) / 100 : 50;
  const noShare = 100 - yesShare;
  const canPredict = !previewMode && !closed && market.status === 0 && !position;
  const displayedCandles = priceSeries?.candles.filter(candle => candle.time >= Date.now() - chartRanges[range].seconds * 1000) || [];

  // AMM / Order pricing computations
  const currentPrice = side === 0 ? Math.max(0.01, yesShare / 100) : Math.max(0.01, noShare / 100);
  const numericAmount = parseFloat(amount) || 0;
  const estShares = numericAmount > 0 && currentPrice > 0 ? (numericAmount / currentPrice).toFixed(2) : '0.00';
  const estPayout = numericAmount > 0 && currentPrice > 0 ? `${(numericAmount / currentPrice).toFixed(2)} XLM` : '0.00 XLM';
  const estReturnMultiplier = currentPrice > 0 ? (1 / currentPrice).toFixed(2) : '1.00';

  const isUserConnected = Boolean(address);
  const isUserSignedIn = Boolean(authenticated);
  const canPlaceOrder = isUserConnected || isUserSignedIn;

  return (
    <div className="market-detail-page">
      <Link className="back-link" to="/markets">
        <PhosphorIcon name="arrowLeft" size={14} /> All markets
      </Link>
      <header className="detail-heading">
        <div className="detail-title-group">
          <MarketAvatar market={market} size="large" />
          <div>
            <p className="eyebrow">{market.kind === 'Price' ? `${market.asset} PRICE MARKET` : 'EVENT MARKET'} · #{market.id}</p>
            <h1>{market.question}</h1>
            <p className="detail-meta">
              <span className="status-pill">{status}</span>
              <span>Total Volume: <strong>{formatAmount(totalPool)} XLM</strong></span>
              <span>Closes {new Date(Number(market.closes_at) * 1000).toLocaleString()}</span>
            </p>
          </div>
        </div>
        <button className="button button-secondary" onClick={() => navigator.clipboard?.writeText(window.location.href)}>
          Copy link
        </button>
      </header>

      <div className="detail-layout">
        <div className="detail-main-column">
          <section className="detail-chart-panel">
            <div className="detail-section-heading">
              <div>
                <p className="eyebrow">{market.kind === 'Price' ? 'LIVE PRICE HISTORY' : 'LIVE CONTRACT DATA'}</p>
                <h2>{market.kind === 'Price' ? `${market.asset}/USD` : 'Pool distribution'}</h2>
              </div>
              {market.kind === 'Price' ? (
                <div className="chart-range-controls" role="group" aria-label="Chart date range">
                  {Object.entries(chartRanges).map(([id, value]) => (
                    <button key={id} type="button" className={range === id ? 'is-active' : ''} aria-pressed={range === id} onClick={() => setRange(id)}>
                      {value.label}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="detail-period">On-chain</span>
              )}
            </div>
            {market.kind === 'Price' ? (
              chartLoading && !displayedCandles.length ? (
                <div className="detail-chart-empty" role="status">Loading live Coinbase candles…</div>
              ) : chartError ? (
                <div className="detail-chart-empty" role="status">{chartError}</div>
              ) : displayedCandles.length > 1 ? (
                <MiniChart candles={displayedCandles} asset={market.asset} source={priceSeries.source} granularity={priceSeries.granularity} periodLabel={chartRanges[range].label} />
              ) : (
                <div className="detail-chart-empty" role="status">Not enough live candle data for this range.</div>
              )
            ) : (
              <>
                <div className="probability-bar" role="img" aria-label={`YES pool share ${yesShare} percent, NO pool share ${noShare} percent`}>
                  <span style={{width: `${yesShare}%`}} />
                </div>
                <div className="probability-labels">
                  <span>YES share <strong>{yesShare.toFixed(2)}%</strong> ({(yesShare / 100).toFixed(2)} XLM)</span>
                  <span>NO share <strong>{noShare.toFixed(2)}%</strong> ({(noShare / 100).toFixed(2)} XLM)</span>
                </div>
                <p className="chart-onchain-note">Computed from the current on-chain YES and NO liquidity pools.</p>
              </>
            )}
          </section>

          <SettlementEvidence
            key={market.id}
            market={market}
            contractId={contractId}
            refundable={timedOut || market.status === 3}
          />
        </div>
        <aside className="detail-trade-column">
          <section className="trade-panel" aria-label="Trade this market">
            <p className="eyebrow">LEGACY ON-CHAIN MARKET</p>
            <h2>{position && BigInt(position.amount) > 0n ? 'Your position' : 'Take a position'}</h2>
            {position && BigInt(position.amount) > 0n ? (
              <div className="position-note" role="status">
                You hold <strong>{position.side === 0 ? 'YES' : 'NO'}</strong> with {formatAmount(position.amount)} XLM staked.
              </div>
            ) : canPredict && isUserConnected ? (
              <form className="detail-trade-form" onSubmit={event => {
                event.preventDefault();
                Promise.resolve(onPredict(market.id, side, amount)).then(() => onRefreshMarket?.(market.id));
              }}>
                <div className="trade-outcome yes-outcome">
                  <span>YES pool share</span><strong>{yesShare.toFixed(2)}%</strong>
                </div>
                <div className="trade-outcome no-outcome">
                  <span>NO pool share</span><strong>{noShare.toFixed(2)}%</strong>
                </div>
                <div className="segmented-control" role="group" aria-label="Choose an outcome">
                  <button type="button" className={side === 0 ? 'yes-selected' : ''} aria-pressed={side === 0} onClick={() => setSide(0)}>YES</button>
                  <button type="button" className={side === 1 ? 'no-selected' : ''} aria-pressed={side === 1} onClick={() => setSide(1)}>NO</button>
                </div>
                <label className="amount-input">
                  <span>Stake</span>
                  <input aria-label="Stake amount in XLM" type="number" min="0.1" step="0.1" value={amount} onChange={event => setAmount(event.target.value)} />
                  <span>XLM</span>
                </label>
                <p className="position-note">Estimated shares: <strong>{estShares}</strong> · Estimated payout: <strong>{estPayout}</strong></p>
                <button type="submit" className="button button-primary market-submit" disabled={busy || numericAmount <= 0}>Confirm position</button>
              </form>
            ) : canPredict && !isUserConnected && isUserSignedIn ? (
              <div className="detail-trade-form">
                <p className="position-note">Connect Freighter to approve a Stellar Testnet transaction.</p>
                <button type="button" className="button button-primary market-submit" disabled={busy} onClick={onConnect}>Connect Freighter</button>
              </div>
            ) : !canPlaceOrder ? (
              <p className="preview-note">Sign in and connect a Testnet wallet to trade this market.</p>
            ) : timedOut || market.status === 3 ? (
              <p className="position-note">This market is refundable. Any unclaimed position can be claimed below.</p>
            ) : closed && market.status === 0 ? (
              <p className="position-note">Trading is closed. The market can now request resolution.</p>
            ) : (
              <p className="preview-note">This market is not accepting new positions.</p>
            )}
            {market.status === 0 && closed && !timedOut && (
              <button type="button" className="button button-secondary market-submit" disabled={busy} onClick={() => {
                Promise.resolve(onRequest(market.id)).then(() => onRefreshMarket?.(market.id));
              }}>Request resolution</button>
            )}
            {canClaim && (
              <button type="button" className="button button-primary market-submit" disabled={busy} onClick={() => {
                Promise.resolve(onClaim(market.id)).then(() => onRefreshMarket?.(market.id));
              }}>
                Claim {market.status === 2 ? 'payout' : 'refund'}
              </button>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
