import {useEffect, useState} from 'react';
import {Link, useLocation} from 'react-router-dom';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

const menuItems = [
  {to: '/profile', label: 'Profile'},
  {to: '/how-to-use', label: 'How to use'},
  {to: '/how-it-works', label: 'How it works'},
  {to: '/terms', label: 'Terms of use'},
  {to: '/privacy', label: 'Privacy policy'},
  {to: '/risk', label: 'Risk disclosure'},
  {to: '/licenses', label: 'Licenses'},
];

const shortAddress = address => `${address.slice(0, 5)}…${address.slice(-5)}`;

export default function Header({address, busy, previewMode, search, onSearch, sidebarCollapsed, onToggleSidebar, onConnect, onDisconnect, onLogin, onLogout, authenticated, authEnabled, onActivity, onCreate}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  useEffect(() => setMenuOpen(false), [location.pathname]);

  return <header className="topbar" id="top">
    <div className="brand-cluster"><button className="icon-button sidebar-toggle" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} onClick={onToggleSidebar}><PhosphorIcon name={sidebarCollapsed ? 'sidebarExpand' : 'sidebarCollapse'} size={18} /></button><Link className="brand" to="/markets" aria-label="RevMarket home"><span className="brand-mark"><PhosphorIcon name="chart" size={20} /></span><span>Rev<span>Market</span></span></Link></div>
    <label className="search-box"><PhosphorIcon name="search" size={18} /><input aria-label="Search markets" value={search} onChange={event => onSearch(event.target.value)} placeholder="Search markets, questions, assets..." />{search && <button className="search-clear" aria-label="Clear search" onClick={() => onSearch('')}>×</button>}</label>
    <div className="topbar-actions">
      <button className="icon-button activity-action" title="Activity" aria-label="Activity" onClick={onActivity}><PhosphorIcon name="bell" /></button>
      <button className="button button-primary auth-action" disabled={!authenticated && !authEnabled} title={!authenticated && !authEnabled ? 'Configure VITE_PRIVY_APP_ID to enable sign-in' : undefined} onClick={() => authenticated ? onLogout?.() : onLogin?.()}>{authenticated ? 'Sign out' : 'Sign in'}</button>
      <button className="wallet-button" aria-label={address ? `Disconnect Freighter wallet ${shortAddress(address)}` : 'Connect Freighter Stellar wallet'} title={address ? 'Disconnect Freighter wallet' : 'Connect a Stellar wallet with Freighter'} disabled={busy} onClick={address ? onDisconnect : onConnect}>{address && <span className="wallet-dot is-connected" />}<PhosphorIcon name="wallet" size={16} /><span>{address ? shortAddress(address) : 'Connect Freighter'}</span></button>
      <div className="menu-wrap">
        <button className="icon-button menu-trigger" aria-label={menuOpen ? 'Close dashboard menu' : 'Open dashboard menu'} title={menuOpen ? 'Close dashboard menu' : 'Open dashboard menu'} aria-expanded={menuOpen} aria-haspopup="true" onClick={() => setMenuOpen(open => !open)}><PhosphorIcon name="grid" size={20} /></button>
        {menuOpen && <nav className="menu-dropdown" aria-label="Account and information">
          {!previewMode && <button onClick={() => {setMenuOpen(false); onCreate?.();}}>Create market</button>}
          {menuItems.map(item => <Link key={item.to} to={item.to}>{item.label}</Link>)}
          <button onClick={onActivity}>Activity</button>
        </nav>}
      </div>
    </div>
  </header>;
}