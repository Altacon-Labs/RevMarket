import {useEffect, useState} from 'react';
import {Link} from 'react-router-dom';
import {api, signInActivity} from '../lib/backend.mjs';

const shortAddress = address => `${address.slice(0, 8)}…${address.slice(-6)}`;

export default function SettingsPage({address, busy, authenticated, authEnabled, user, contractId, rpcUrl, onLogin, onLogout, onConnect, onDisconnect}) {
  const [adminState, setAdminState] = useState({status: 'unverified', message: ''});
  const [adminBusy, setAdminBusy] = useState(false);
  const email = user?.email?.address;
  const rpcHost = (() => {try {return new URL(rpcUrl).host;} catch {return 'Configured RPC';}})();

  useEffect(() => setAdminState({status: 'unverified', message: ''}), [address]);

  async function verifySuperAdmin() {
    if (!address || adminBusy) return;
    setAdminBusy(true);
    try {
      let access;
      try {
        access = await api('/admin/network');
      } catch (error) {
        if (error.status !== 401) throw error;
        await signInActivity(address);
        access = await api('/admin/network');
      }
      setAdminState({status: 'authorized', message: '', access});
    } catch (error) {
      setAdminState({status: error.status === 403 ? 'denied' : 'error', message: error.status === 403 ? 'This wallet is not in the server super-admin allowlist.' : error.message || 'Super-admin verification failed.'});
    } finally {
      setAdminBusy(false);
    }
  }

  return <div className="settings-page">
    <div className="page-heading"><div><p className="eyebrow">PREFERENCES & SECURITY</p><h1>Settings</h1></div></div>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">ACCOUNT</p><h2>RevMarket sign-in</h2><p>Privy keeps your app account separate from Stellar transaction approvals.</p></div><span className={`settings-state${authenticated ? ' is-active' : ''}`}>{authenticated ? 'Signed in' : 'Not signed in'}</span></div><div className="settings-detail-row"><span>Email</span><strong>{email || 'No email linked'}</strong></div><div className="settings-detail-row"><span>Authentication</span><strong>{authEnabled ? 'Privy email and web3 wallet' : 'Set VITE_PRIVY_APP_ID to enable Privy'}</strong></div>{authenticated ? <button className="button button-secondary" onClick={() => onLogout?.()}>Sign out</button> : <button className="button button-secondary" disabled={!authEnabled} onClick={() => onLogin?.()}>Sign in</button>}</section>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">STELLAR WALLET</p><h2>Transaction account</h2><p>Freighter signs transactions on Stellar Testnet. Privy login does not authorize spending.</p></div><span className={`settings-state${address ? ' is-active' : ''}`}>{address ? 'Connected' : 'Disconnected'}</span></div><div className="settings-detail-row"><span>Address</span><strong>{address ? shortAddress(address) : 'No Freighter account connected'}</strong></div>{address ? <button className="button button-secondary" disabled={busy} onClick={onDisconnect}>Disconnect Freighter</button> : <button className="button button-secondary" disabled={busy} onClick={onConnect}>Connect Freighter</button>}</section>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">NETWORK</p><h2>Stellar Testnet</h2><p>Market creation and positions use the configured Soroban contract.</p></div><span className="settings-state is-active">Testnet</span></div><div className="settings-detail-row"><span>RPC host</span><strong>{rpcHost}</strong></div><div className="settings-detail-row"><span>Contract</span><strong>{contractId || 'Not configured'}</strong></div><div className="settings-detail-row"><span>Market status</span><strong>{contractId ? 'Reading from contract' : 'Read-only: no contract configured'}</strong></div></section>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">ADMINISTRATOR</p><h2>Network access</h2><p>Super-admin access is checked by the backend against the server-side wallet allowlist.</p></div><span className={`settings-state${adminState.status === 'authorized' ? ' is-active' : ''}`}>{adminState.status === 'authorized' ? 'Super admin' : adminState.status === 'denied' ? 'Not authorized' : 'Not verified'}</span></div><button className="button button-secondary" disabled={!address || adminBusy} onClick={verifySuperAdmin}>{adminBusy ? 'Verifying wallet…' : adminState.status === 'authorized' ? 'Refresh admin access' : 'Verify super-admin access'}</button>{adminState.message && <p className={adminState.status === 'error' ? 'form-error' : 'form-note'} role={adminState.status === 'error' ? 'alert' : 'status'}>{adminState.message}</p>}{adminState.status === 'authorized' && <><div className="network-switch" role="group" aria-label="Select Stellar network"><button type="button" className="is-active" aria-pressed="true">Testnet</button><button type="button" disabled={!adminState.access.networks.mainnet.available} title={adminState.access.networks.mainnet.reason} aria-pressed="false">Mainnet</button></div><p className="form-note">{adminState.access.networks.mainnet.reason}</p></>}</section>
    <section className="settings-section"><div className="settings-section-heading"><div><p className="eyebrow">MARKET DATA</p><h2>Price charts</h2><p>Price-market detail charts use 5-minute, hourly, or 6-hour USD candles fetched directly from Coinbase. Event markets show live on-chain pool shares instead of simulated history.</p></div><span className="settings-state is-active">Live source</span></div><div className="settings-detail-row"><span>Supported assets</span><strong>BTC · ETH · XLM</strong></div><div className="settings-detail-row"><span>Refresh interval</span><strong>60 seconds</strong></div></section>
    <section className="settings-section settings-links"><div className="settings-section-heading"><div><p className="eyebrow">POLICIES</p><h2>Account and protocol information</h2></div></div><Link to="/privacy">Privacy policy <span>→</span></Link><Link to="/risk">Risk disclosure <span>→</span></Link><Link to="/terms">Terms of use <span>→</span></Link></section>
  </div>;
}