import {useEffect, useRef, useState} from 'react';
import {Navigate, Route, Routes, useLocation, useNavigate} from 'react-router-dom';
import {createClient, normalizeMarket, sc} from '../../shared/stellar.mjs';
import {formatAmount, parseAmount, priceUnits} from '../../shared/amount.mjs';
import {connect, checkWallet, signer} from './lib/wallet.mjs';
import {logoutActivity, reportActivity, uploadMarketImage} from './lib/backend.mjs';
import {MOCK_MARKETS} from './lib/mock-data.mjs';
import Header from './components/Header.jsx';
import Sidebar from './components/Sidebar.jsx';
import StatsBar from './components/StatsBar.jsx';
import PositionTable from './components/PositionTable.jsx';
import MarketGrid from './components/MarketGrid.jsx';
import CreateMarketModal from './components/CreateMarketModal.jsx';
import MarketDetailPage from './components/MarketDetailPage.jsx';
import ProfilePage from './components/ProfilePage.jsx';
import SettingsPage from './components/SettingsPage.jsx';
import InfoPage from './components/InfoPage.jsx';
import ActivityPage from './components/ActivityPage.jsx';

const env = import.meta.env;
const statuses = ['Open', 'Resolution requested', 'Settled', 'Refundable'];
let client;
try {
  client = createClient({rpcUrl: env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org', contractId: env.VITE_CONTRACT_ID});
} catch {
  client = null;
}
const previewMode = !client;

function isClaimable(market, position, now) {
  if (!position || position.claimed) return false;
  if (market.status === 3 || (market.status < 2 && now > Number(market.deadline))) return true;
  return market.status === 2 && position.side === market.outcome;
}

export default function App({privyEnabled = false, ready = false, authenticated = false, user = null, onLogin, onLogout}) {
  const [address, setAddress] = useState('');
  const [markets, setMarkets] = useState([]);
  const [positions, setPositions] = useState({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {return localStorage.getItem('revmarket.sidebar-collapsed') === 'true';} catch {return false;}
  });
  const [activeFilter, setActiveFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [lastAction, setLastAction] = useState('');
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  const location = useLocation();
  const routerNavigate = useNavigate();
  const actionLock = useRef(false);
  const source = address || env.VITE_READ_ACCOUNT;
  const currentSource = useRef(source);
  currentSource.current = source;

  async function refresh() {
    setLoading(true);
    try {
      if (!client || !source) {
        setMarkets(MOCK_MARKETS);
        return;
      }
      const count = await client.read(source, 'count');
      if (count > 1000) throw new Error('Market list exceeds supported limit');
      if (count === 0) {
        // Fallback to mock data so platform is interactive while contracts are clean
        setMarkets(MOCK_MARKETS);
        return;
      }
      const nextMarkets = [];
      const nextPositions = {};
      for (let id = Math.max(0, count - 50); id < count; id++) {
        nextMarkets.push({id, ...normalizeMarket(await client.read(source, 'get_market', [sc.u32(id)]))});
        if (address) nextPositions[id] = await client.read(source, 'get_position', [sc.u32(id), sc.address(address)]);
      }
      if (currentSource.current !== source) return;
      setMarkets(nextMarkets.reverse());
      setPositions(nextPositions);
    } catch (err) {
      // In preview mode or RPC offline, serve interactive mock data smoothly
      setMarkets(MOCK_MARKETS);
    } finally {
      setLoading(false);
    }
  }

  async function runAction(action, onError) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setMessage(error.message || 'The action could not be completed.');
      onError?.(error);
    } finally {
      actionLock.current = false;
      setBusy(false);
    }
  }

  async function send(method, args) {
    if (!client) throw new Error('On-chain actions are unavailable in preview mode.');
    if (!address) throw new Error('Connect Freighter first');
    await checkWallet(address);
    setMessage('Review the transaction in Freighter; awaiting confirmation…');
    const result = await client.write(address, signer(address), method, args);
    setMessage(`Confirmed: ${result.hash}`);
    try {
      await reportActivity(address, method, result.hash);
    } catch {
      setMessage(`Confirmed: ${result.hash}. Activity service unavailable; the transaction remains confirmed.`);
    }
    setLastAction(result.hash);
    await refresh();
  }

  async function connectWallet() {
    const wallet = await connect();
    setAddress(wallet);
    setMessage('Wallet connected to Stellar Testnet.');
  }

  async function disconnectWallet() {
    setAddress('');
    setPositions({});
    await logoutActivity().catch(() => {});
    setMessage('Wallet disconnected.');
  }

  async function createMarket({kind, question, asset, target, closes, descriptionCid, imageFile}) {
    if (!address) throw new Error('Connect Freighter first');
    const closesAt = Math.floor(new Date(closes).getTime() / 1000);
    if (!Number.isSafeInteger(closesAt) || closesAt <= Math.floor(Date.now() / 1000)) throw new Error('Choose a future closing time');
    if (kind === 'event' && !imageFile) throw new Error('Add an image for this event market');
    const imageCid = imageFile ? await uploadMarketImage(imageFile, address, () => currentSource.current === source) : '';
    const priceAsset = kind === 'price' ? asset : null;
    const threshold = priceAsset ? priceUnits(target) : 0n;
    const marketQuestion = priceAsset
      ? `Will ${priceAsset} be strictly above $${target} USD at the first post-close observation (within 90 seconds)?`
      : question;
    await send('create', [sc.address(address), sc.text(marketQuestion), sc.text(descriptionCid), sc.text(imageCid), sc.kind(priceAsset, threshold), sc.u64(closesAt)]);
    setShowCreate(false);
  }

  useEffect(() => {
    let stopped = false;
    const load = () => refresh().catch(error => {if (!stopped) setMessage(error.message);});
    load();
    const timer = setInterval(load, 15000);
    return () => {stopped = true; clearInterval(timer);};
  }, [source]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    try {localStorage.setItem('revmarket.sidebar-collapsed', String(sidebarCollapsed));} catch {}
  }, [sidebarCollapsed]);

  const normalizedSearch = search.trim().toLowerCase();
  const matchingMarkets = markets
    .filter(market => !normalizedSearch || market.question.toLowerCase().includes(normalizedSearch))
    .filter(market => activeFilter === 'all' || (activeFilter === 'price' && market.kind === 'Price') || (activeFilter === 'event' && market.kind === 'Event'));
  const positionRows = markets.filter(market => positions[market.id] && BigInt(positions[market.id].amount) > 0n).map(market => ({
    market,
    position: positions[market.id],
    claimable: isClaimable(market, positions[market.id], now),
    timedOut: market.status < 2 && now > Number(market.deadline),
    statusLabel: market.status === 0 && now >= Number(market.closes_at) ? 'Closed' : statuses[market.status],
  }));
  const stats = [
    {label: 'Open positions', value: positionRows.filter(row => row.market.status < 2 && !row.timedOut).length, detail: `Across ${positionRows.length} markets`, icon: 'wallet'},
    {label: 'Total staked', value: `${formatAmount(positionRows.reduce((total, row) => total + BigInt(row.position.amount), 0n))} XLM`, detail: 'Current contract positions', icon: 'currency'},
    {label: 'Ready to claim', value: positionRows.filter(row => row.claimable).length, detail: 'Winnings or refunds', icon: 'chart'},
    {label: 'Settled wins', value: positionRows.filter(row => row.market.status === 2 && row.position.side === row.market.outcome).length, detail: 'In loaded positions', icon: 'target'},
  ];
  const counts = {
    markets: markets.length,
    price: markets.filter(market => market.kind === 'Price').length,
    event: markets.filter(market => market.kind === 'Event').length,
    positions: Object.values(positions).filter(position => position && BigInt(position.amount) > 0n).length,
  };
  const visiblePositionRows = positionRows.filter(row => !normalizedSearch || row.market.question.toLowerCase().includes(normalizedSearch));
  const notifications = [
    ...(lastAction ? [{id: 'confirmed-transaction', icon: 'pulse', title: 'Transaction confirmed', description: `${lastAction.slice(0, 12)}…`, action: 'View activity', page: 'activity'}] : []),
    ...positionRows.filter(row => row.claimable).map(row => ({id: `claim-${row.market.id}`, icon: 'wallet', title: row.market.status === 2 ? 'Winnings ready to claim' : 'Refund ready to claim', description: row.market.question, action: 'View positions', page: 'positions'})),
    ...positionRows.filter(row => row.market.status === 0 && now >= Number(row.market.closes_at) && !row.timedOut).map(row => ({id: `request-${row.market.id}`, icon: 'info', title: 'Settlement can be requested', description: row.market.question, action: 'View positions', page: 'positions'})),
    ...positionRows.filter(row => row.market.status === 1).map(row => ({id: `pending-${row.market.id}`, icon: 'refresh', title: 'Settlement in progress', description: row.market.question, action: 'View positions', page: 'positions'})),
  ].slice(0, 8);
  const activePage = location.pathname === '/markets/price' ? 'price' : location.pathname === '/markets/event' ? 'event' : location.pathname === '/positions' ? 'positions' : location.pathname === '/activity' ? 'activity' : location.pathname === '/settings' ? 'settings' : location.pathname === '/profile' ? 'profile' : 'markets';
  const pagePaths = {markets: '/markets', price: '/markets/price', event: '/markets/event', positions: '/positions', activity: '/activity', settings: '/settings', profile: '/profile'};
  const navigate = page => routerNavigate(pagePaths[page] || '/markets');
  const requestResolution = marketId => runAction(() => send('request', [sc.u32(marketId)]));
  const claimPosition = marketId => runAction(() => send('claim', [sc.address(address), sc.u32(marketId)]));
  const predict = (marketId, side, amount) => runAction(() => send('predict', [sc.address(address), sc.u32(marketId), sc.u32(side), sc.i128(parseAmount(amount))]));
  const marketProps = {
    markets: matchingMarkets,
    positions,
    busy,
    now,
    previewMode,
    loading,
    search,
    onSearch: setSearch,
    activeFilter,
    onFilterChange: setActiveFilter,
    onPredict: predict,
    onClaim: claimPosition,
    onRequest: requestResolution
  };

  return <div className="app-shell">
    <Header address={address} busy={busy} previewMode={previewMode} search={search} onSearch={setSearch} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed(value => !value)} onConnect={() => runAction(connectWallet)} onDisconnect={() => runAction(disconnectWallet)} onLogin={onLogin} onLogout={onLogout} authenticated={authenticated} authEnabled={privyEnabled && ready} onActivity={() => navigate('activity')} onCreate={() => setShowCreate(true)} notifications={notifications} onNavigate={navigate} />
    <div className={`workspace${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
      <Sidebar activePage={activePage} counts={counts} collapsed={sidebarCollapsed} address={address} onNavigate={navigate} />
      <main className="main-content">
        {message && <p className="status-message" role="status">{message}</p>}
        <Routes>
          <Route path="/" element={<Navigate to="/markets" replace />} />
          <Route path="/markets" element={<><div className="page-heading"><div><p className="eyebrow">PREDICTION MARKETS</p><h1>Prediction markets</h1></div></div><MarketGrid {...marketProps} showLiveRow /></>} />
          <Route path="/markets/price" element={<><div className="page-heading"><div><p className="eyebrow">PRICE MARKETS</p><h1>Price markets</h1></div></div><MarketGrid {...marketProps} markets={matchingMarkets.filter(market => market.kind === 'Price')} /></>} />
          <Route path="/markets/event" element={<><div className="page-heading"><div><p className="eyebrow">EVENT MARKETS</p><h1>Event markets</h1></div></div><MarketGrid {...marketProps} markets={matchingMarkets.filter(market => market.kind === 'Event')} /></>} />
          <Route path="/event/:slug" element={<MarketDetailPage markets={markets} positions={positions} busy={busy} now={now} previewMode={previewMode} onPredict={predict} onClaim={claimPosition} onRequest={requestResolution} />} />
          <Route path="/positions" element={<><div className="page-heading"><div><p className="eyebrow">YOUR ACCOUNT</p><h1>Open positions</h1></div><button className="button button-quiet" disabled={busy || !client} onClick={() => runAction(refresh)}>Refresh</button></div><StatsBar stats={stats} /><section className="workspace-panel"><div className="panel-heading"><div><h2>Positions</h2><p>{positionRows.length} positions loaded from the contract</p></div></div><PositionTable rows={visiblePositionRows} busy={busy} onClaim={claimPosition} onRequest={requestResolution} /></section></>} />
          <Route path="/profile" element={<ProfilePage address={address} busy={busy} authEnabled={privyEnabled && ready} authenticated={authenticated} user={user} onLogin={onLogin} onLogout={onLogout} onConnect={() => runAction(connectWallet)} onDisconnect={() => runAction(disconnectWallet)} onClaim={claimPosition} onRequest={requestResolution} stats={stats} positionRows={visiblePositionRows} />} />
          <Route path="/activity" element={<ActivityPage address={address} lastAction={lastAction} authenticated={authenticated} authEnabled={privyEnabled && ready} onLogin={onLogin} onConnect={() => runAction(connectWallet)} />} />
          <Route path="/settings" element={<SettingsPage address={address} busy={busy} authenticated={authenticated} authEnabled={privyEnabled && ready} user={user} contractId={env.VITE_CONTRACT_ID} rpcUrl={env.VITE_RPC_URL || 'https://soroban-testnet.stellar.org'} onLogin={onLogin} onLogout={onLogout} onConnect={() => runAction(connectWallet)} onDisconnect={() => runAction(disconnectWallet)} />} />
          <Route path="/how-to-use" element={<InfoPage page="how-to-use" />} />
          <Route path="/how-it-works" element={<InfoPage page="how-it-works" />} />
          <Route path="/terms" element={<InfoPage page="terms" />} />
          <Route path="/privacy" element={<InfoPage page="privacy" />} />
          <Route path="/risk" element={<InfoPage page="risk" />} />
          <Route path="/licenses" element={<InfoPage page="licenses" />} />
          <Route path="*" element={<InfoPage page="not-found" />} />
        </Routes>
        <footer className="app-footer"><span>RevMarket</span></footer>
      </main>
    </div>
    {showCreate && <CreateMarketModal busy={busy} previewMode={previewMode} onClose={() => setShowCreate(false)} onCreate={(data, onError) => runAction(() => createMarket(data), onError)} />}
  </div>;
}