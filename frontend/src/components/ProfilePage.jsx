import {Link} from 'react-router-dom';
import StatsBar from './StatsBar.jsx';
import PositionTable from './PositionTable.jsx';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

export default function ProfilePage({address, busy, authEnabled, authenticated, user, onLogin, onLogout, onConnect, onDisconnect, onClaim, onRequest, stats, positionRows}) {
  const email = user?.email?.address;
  const privyWallet = user?.wallet?.address;
  return <div className="profile-page">
    <div className="page-heading"><div><p className="eyebrow">ACCOUNT</p><h1>Your profile</h1></div></div>
    <section className="profile-account-panel"><div className="profile-avatar">{(email || address || 'R').slice(0, 1).toUpperCase()}</div><div className="profile-account-copy"><h2>{email || (address ? `${address.slice(0, 8)}…${address.slice(-6)}` : 'Your RevMarket account')}</h2><p>{authenticated ? 'Signed in with Privy' : 'Sign in with email or a supported web3 wallet'}</p></div><div className="profile-account-actions">{authenticated ? <button className="button button-secondary" onClick={() => onLogout?.()}>Sign out</button> : <button className="button button-primary" disabled={!authEnabled || busy} title={!authEnabled ? 'Configure VITE_PRIVY_APP_ID to enable Privy sign-in' : undefined} onClick={() => onLogin?.()}>Sign in</button>}</div></section>
    {authenticated && <section className="profile-identities"><div><p className="eyebrow">PRIVY ACCOUNT</p><h2>Web account</h2><p>{email || 'No email linked'}{privyWallet ? ` · ${privyWallet.slice(0, 8)}…${privyWallet.slice(-6)}` : ''}</p></div><div><p className="eyebrow">STELLAR TRANSACTIONS</p><h2>{address ? `${address.slice(0, 8)}…${address.slice(-6)}` : 'Freighter not connected'}</h2><p>Privy authentication does not authorize Stellar transactions.</p>{address ? <button className="button button-secondary" disabled={busy} onClick={onDisconnect}>Disconnect Freighter</button> : <button className="button button-secondary" disabled={busy} onClick={onConnect}>Connect Freighter</button>}</div></section>}
    <StatsBar stats={stats} />
    <section className="workspace-panel"><div className="panel-heading"><div><h2>Recent positions</h2><p>{positionRows.length} positions loaded from the Stellar contract</p></div><Link className="market-card-cta" to="/positions">All positions <PhosphorIcon name="arrowRight" size={14} /></Link></div><PositionTable rows={positionRows} busy={busy} onClaim={onClaim} onRequest={onRequest} limit={5} /></section>
  </div>;
}