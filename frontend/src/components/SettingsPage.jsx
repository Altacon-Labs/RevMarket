import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Link} from 'react-router-dom';
import {api, ensureActivitySession} from '../lib/backend.mjs';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

const shortAddress = address => `${address.slice(0, 8)}…${address.slice(-6)}`;

function sessionError(error) {
  if (error.status === 401 || /signature|challenge expired/i.test(error.message)) {
    return {status: 'needs-signature', message: error.message || 'The backend session expired. Sign in again.'};
  }
  if (error.code === 'API_UNREACHABLE' || error.code === 'INVALID_API_RESPONSE' || error.name === 'TimeoutError') {
    return {status: 'unavailable', message: 'The activity service could not be reached. Try again when it is available.'};
  }
  return {status: 'error', message: error.message || 'Backend session check failed.'};
}

export default function SettingsPage({address, busy, authenticated, authEnabled, user, contractId, rpcUrl, onLogin, onLogout, onConnect, onDisconnect}) {
  const [adminState, setAdminState] = useState({status: 'unverified', message: '', access: null});
  const [sessionState, setSessionState] = useState({status: 'unchecked', message: ''});
  const [sessionBusy, setSessionBusy] = useState(false);
  const operation = useRef(0);
  const activeAddress = useRef(address);
  activeAddress.current = address;
  const email = user?.email?.address;
  const rpcHost = (() => {try {return new URL(rpcUrl).host;} catch {return 'Configured RPC';}})();

  useLayoutEffect(() => {
    operation.current++;
    setAdminState({status: 'unverified', message: '', access: null});
    setSessionState({status: address ? 'unchecked' : 'disconnected', message: ''});
  }, [address]);

  useEffect(() => {
    const clearProtectedState = event => {
      operation.current++;
      setAdminState({status: 'unverified', message: '', access: null});
      const expired = event.detail?.reason !== 'logout';
      setSessionState({
        status: address ? (expired ? 'needs-signature' : 'unchecked') : 'disconnected',
        message: address ? `The signed backend session ${expired ? 'expired' : 'was signed out'}. Check or sign in again.` : '',
      });
    };
    window.addEventListener('revmarket:activity-session-invalidated', clearProtectedState);
    return () => window.removeEventListener('revmarket:activity-session-invalidated', clearProtectedState);
  }, [address]);

  function isCurrent(wallet, version) {
    return activeAddress.current === wallet && operation.current === version;
  }

  async function checkBackendSession() {
    if (!address || sessionBusy) return;
    const wallet = address;
    const version = ++operation.current;
    setSessionBusy(true);
    setSessionState({status: 'checking', message: ''});
    try {
      const {established} = await ensureActivitySession(wallet, {isCurrent: () => isCurrent(wallet, version)});
      if (!isCurrent(wallet, version)) return;
      setSessionState({
        status: 'signed-in',
        message: established ? 'Signed backend session established for this Freighter wallet.' : 'A valid signed backend session already matches this Freighter wallet.',
      });
    } catch (error) {
      if (isCurrent(wallet, version)) setSessionState(sessionError(error));
    } finally {
      if (isCurrent(wallet, version)) setSessionBusy(false);
    }
  }

  async function verifySuperAdmin() {
    if (!address || sessionBusy) return;
    const wallet = address;
    const version = ++operation.current;
    setSessionBusy(true);
    setAdminState({status: 'checking', message: '', access: null});
    setSessionState({status: 'checking', message: ''});
    try {
      const {established} = await ensureActivitySession(wallet, {isCurrent: () => isCurrent(wallet, version)});
      if (!isCurrent(wallet, version)) return;
      setSessionState({
        status: 'signed-in',
        message: established ? 'Signed backend session established for this Freighter wallet.' : 'A valid signed backend session already matches this Freighter wallet.',
      });

      const access = await api('/admin/network');
      const profile = await api('/me');
      if (profile.wallet !== wallet) throw new Error('Backend session wallet changed; admin access was cleared.');
      if (!isCurrent(wallet, version)) return;
      setAdminState({status: 'authorized', message: '', access});
    } catch (error) {
      if (!isCurrent(wallet, version)) return;
      setAdminState({
        status: error.status === 403 ? 'denied' : 'unverified',
        message: error.status === 403 ? 'This wallet is not in the server super-admin allowlist.' : '',
        access: null,
      });
      if (error.status === 403) {
        setSessionState({status: 'signed-in', message: 'Signed backend session matches this Freighter wallet.'});
      } else {
        setSessionState(sessionError(error));
      }
    } finally {
      if (isCurrent(wallet, version)) setSessionBusy(false);
    }
  }

  const sessionLabels = {
    unchecked: 'Not checked',
    disconnected: 'Wallet not connected',
    checking: 'Checking…',
    'signed-in': 'Signed backend session',
    'needs-signature': 'Sign-in needed',
    unavailable: 'Service unavailable',
    error: 'Check failed',
  };
  const adminLabels = {checking: 'Checking…', authorized: 'Super admin', denied: 'Not authorized', unverified: 'Not verified'};

  return <div className="settings-page">
    <div className="page-heading"><div><p className="eyebrow">PREFERENCES & SECURITY</p><h1>Settings</h1></div></div>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div><p className="eyebrow">ACCOUNT</p><h2>RevMarket sign-in</h2><p>Optional app login for your RevMarket account. It is separate from your Stellar wallet and backend session.</p></div>
        <span className={`settings-state${authenticated ? ' is-active' : ''}`}>{authenticated ? 'Signed in' : 'Not signed in'}</span>
      </div>
      <div className="settings-detail-row"><span>Email</span><strong>{email || 'No email linked'}</strong></div>
      <div className="settings-detail-row"><span>Authentication</span><strong>{authEnabled ? 'Privy email and web3 wallet' : 'Unavailable'}</strong></div>
      {authenticated ? <button className="button button-secondary" onClick={() => onLogout?.()}>Sign out</button> : <button className="button button-secondary" disabled={!authEnabled} onClick={() => onLogin?.()}>Sign in</button>}
    </section>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div><p className="eyebrow">STELLAR WALLET</p><h2>Transaction account</h2><p>Freighter signs transactions on Stellar Testnet. App login is optional and does not authorize spending.</p></div>
        <span className={`settings-state${address ? ' is-active' : ''}`}>{address ? 'Connected' : 'Disconnected'}</span>
      </div>
      <div className="settings-detail-row"><span>Address</span><strong>{address ? shortAddress(address) : 'No Freighter account connected'}</strong></div>
      {address ? <button className="button button-secondary" disabled={busy || sessionBusy} onClick={onDisconnect}>Disconnect Freighter</button> : <button className="button button-secondary" disabled={busy} onClick={onConnect}>Connect Freighter</button>}
    </section>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div><p className="eyebrow">BACKEND SESSION</p><h2>Wallet-scoped session</h2><p>A signed Freighter message establishes an off-chain session for the connected address. It is not a transaction approval.</p></div>
        <span className={`settings-state${sessionState.status === 'signed-in' ? ' is-active' : ''}`}>{sessionLabels[sessionState.status]}</span>
      </div>
      <div className="settings-detail-row"><span>Session wallet</span><strong>{address ? shortAddress(address) : 'Connect a Freighter wallet first'}</strong></div>
      <button className="button button-secondary" disabled={!address || sessionBusy} onClick={checkBackendSession}>{sessionBusy ? 'Checking session…' : sessionState.status === 'signed-in' ? 'Check backend session' : 'Check or sign in'}</button>
      {sessionState.message && <p className={sessionState.status === 'error' || sessionState.status === 'unavailable' ? 'form-error' : 'form-note'} role={sessionState.status === 'error' || sessionState.status === 'unavailable' ? 'alert' : 'status'}>{sessionState.message}</p>}
    </section>
    <section className="settings-section">
      <div className="settings-section-heading"><div><p className="eyebrow">NETWORK</p><h2>Stellar Testnet</h2><p>Market creation and positions use the configured Soroban contract.</p></div><span className="settings-state is-active">Testnet</span></div>
      <div className="settings-detail-row"><span>RPC host</span><strong>{rpcHost}</strong></div>
      <div className="settings-detail-row"><span>Contract</span><strong>{contractId || 'Not configured'}</strong></div>
      <div className="settings-detail-row"><span>Market status</span><strong>{contractId ? 'Reading from contract' : 'Read-only: no contract configured'}</strong></div>
    </section>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div><p className="eyebrow">ADMINISTRATOR</p><h2>Network access</h2><p>Super-admin access is checked by the backend against the server-side wallet allowlist.</p></div>
        <span className={`settings-state${adminState.status === 'authorized' ? ' is-active' : ''}`}>{adminLabels[adminState.status] || 'Not verified'}</span>
      </div>
      <button className="button button-secondary" disabled={!address || sessionBusy} onClick={verifySuperAdmin}>{sessionBusy ? 'Verifying wallet…' : adminState.status === 'authorized' ? 'Refresh admin access' : 'Verify super-admin access'}</button>
      {adminState.message && <p className={adminState.status === 'unverified' ? 'form-error' : 'form-note'} role={adminState.status === 'unverified' ? 'alert' : 'status'}>{adminState.message}</p>}
      {adminState.status === 'authorized' && adminState.access && <><div className="network-switch" role="group" aria-label="Select Stellar network"><button type="button" className="is-active" aria-pressed="true">Testnet</button><button type="button" disabled={!adminState.access.networks.mainnet.available} title={adminState.access.networks.mainnet.reason} aria-pressed="false">Mainnet</button></div><p className="form-note">{adminState.access.networks.mainnet.reason}</p></>}
    </section>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">MARKET DATA</p><h2>Price charts</h2><p>Price-market detail charts use 5-minute, hourly, or 6-hour USD candles fetched directly from Coinbase. Event markets show live on-chain pool shares instead of simulated history.</p></div><span className="settings-state is-active">Live source</span></div><div className="settings-detail-row"><span>Supported assets</span><strong>BTC · ETH · XLM</strong></div><div className="settings-detail-row"><span>Refresh interval</span><strong>60 seconds</strong></div></section>
    <section className="settings-section settings-links"><div className="settings-section-heading"><div><p className="eyebrow">POLICIES</p><h2>Account and protocol information</h2></div></div><Link to="/privacy">Privacy policy <PhosphorIcon name="arrowRight" size={14} /></Link><Link to="/risk">Risk disclosure <PhosphorIcon name="arrowRight" size={14} /></Link><Link to="/terms">Terms of use <PhosphorIcon name="arrowRight" size={14} /></Link></section>
  </div>;
}
