import {useEffect, useRef, useState} from 'react';
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

export default function Header({
  address,
  busy,
  previewMode,
  search,
  onSearch,
  sidebarCollapsed,
  onToggleSidebar,
  onConnect,
  onDisconnect,
  onLogin,
  onLogout,
  authenticated,
  authEnabled,
  onActivity,
  onCreate,
  notifications = [],
  onNavigate,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [walletDropdownOpen, setWalletDropdownOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const walletWrapRef = useRef(null);
  const location = useLocation();

  useEffect(() => {
    setMenuOpen(false);
    setNotificationsOpen(false);
    setWalletDropdownOpen(false);
  }, [location.pathname]);

  // Click outside listener for wallet dropdown
  useEffect(() => {
    function handleClickOutside(event) {
      if (walletWrapRef.current && !walletWrapRef.current.contains(event.target)) {
        setWalletDropdownOpen(false);
      }
    }
    if (walletDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [walletDropdownOpen]);

  function handleWalletButtonClick() {
    if (!address) {
      onConnect?.();
    } else {
      setMenuOpen(false);
      setNotificationsOpen(false);
      setWalletDropdownOpen(prev => !prev);
    }
  }

  function handleCopyAddress() {
    if (!address) return;
    navigator.clipboard?.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <header className="topbar" id="top">
      <div className={`brand-cluster${sidebarCollapsed ? ' is-sidebar-collapsed' : ''}`}>
        <Link className="brand" to="/markets" aria-label="RevMarket home">
          <span className="brand-mark"><PhosphorIcon name="chart" size={20} /></span>
          <span>Rev<span>Market</span></span>
        </Link>
        <button
          className="sidebar-toggle"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!sidebarCollapsed}
          onClick={onToggleSidebar}
        >
          <PhosphorIcon name={sidebarCollapsed ? 'sidebarExpand' : 'sidebarCollapse'} size={18} />
        </button>
      </div>

      <label className="search-box">
        <PhosphorIcon name="search" size={18} />
        <input
          aria-label="Search markets"
          value={search}
          onChange={event => onSearch(event.target.value)}
          placeholder="Search markets, questions, assets..."
        />
        {search && <button className="search-clear" aria-label="Clear search" onClick={() => onSearch('')}>×</button>}
      </label>

      <div className="topbar-actions">
        <div className="notification-wrap">
          <button
            className="topbar-icon activity-action"
            title="Notifications"
            aria-label={notifications.length ? `Notifications (${notifications.length})` : 'Notifications'}
            aria-expanded={notificationsOpen}
            aria-controls="notification-dropdown"
            onClick={() => {
              setMenuOpen(false);
              setWalletDropdownOpen(false);
              setNotificationsOpen(open => !open);
            }}
          >
            <PhosphorIcon name="bell" />
            {notifications.length > 0 && <span className="notification-count">{notifications.length > 9 ? '9+' : notifications.length}</span>}
          </button>
          {notificationsOpen && (
            <section className="notification-dropdown" id="notification-dropdown" aria-label="Notifications">
              <div className="notification-heading">
                <div>
                  <h2>Notifications</h2>
                  <p>{notifications.length ? `${notifications.length} updates` : 'All caught up'}</p>
                </div>
              </div>
              {notifications.length ? (
                <ul className="notification-list">
                  {notifications.map(notification => (
                    <li key={notification.id}>
                      <button
                        type="button"
                        className="notification-item"
                        onClick={() => {
                          setNotificationsOpen(false);
                          onNavigate(notification.page);
                        }}
                      >
                        <span className="notification-icon"><PhosphorIcon name={notification.icon} size={17} /></span>
                        <span className="notification-copy">
                          <strong>{notification.title}</strong>
                          <span>{notification.description}</span>
                          <small>{notification.action}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="notification-empty">
                  <span className="empty-icon"><PhosphorIcon name="bell" size={19} /></span>
                  <strong>No notifications yet</strong>
                  <p>Updates about your positions and transactions will appear here.</p>
                </div>
              )}
            </section>
          )}
        </div>

        <button
          className="button button-primary auth-action"
          disabled={!authenticated && !authEnabled}
          title={!authenticated && !authEnabled ? 'Configure VITE_PRIVY_APP_ID to enable sign-in' : undefined}
          onClick={() => (authenticated ? onLogout?.() : onLogin?.())}
        >
          {authenticated ? 'Sign out' : 'Sign in'}
        </button>

        {/* Freighter Wallet Container with Dropdown Menu */}
        <div className="wallet-wrap" ref={walletWrapRef}>
          <button
            className={`wallet-button${address ? ' has-dropdown' : ''}`}
            aria-label={address ? `Freighter wallet ${shortAddress(address)}. Click for options` : 'Connect Freighter Stellar wallet'}
            title={address ? 'Freighter wallet options' : 'Connect a Stellar wallet with Freighter'}
            aria-expanded={walletDropdownOpen}
            aria-haspopup={address ? 'true' : undefined}
            disabled={busy}
            onClick={handleWalletButtonClick}
          >
            {address && <span className="wallet-dot is-connected" />}
            <PhosphorIcon name="wallet" size={16} />
            <span>{address ? shortAddress(address) : 'Connect Freighter'}</span>
            {address && (
              <span className={`wallet-caret-icon${walletDropdownOpen ? ' is-open' : ''}`}>
                <PhosphorIcon name="caretDown" size={14} />
              </span>
            )}
          </button>

          {address && walletDropdownOpen && (
            <div className="wallet-dropdown" role="menu" aria-label="Wallet actions">
              <div className="wallet-dropdown-header">
                <div className="wallet-dropdown-badge">
                  <span className="wallet-dot is-connected" />
                  <span>Stellar Testnet</span>
                </div>
                <span className="wallet-dropdown-full-address" title={address}>
                  {shortAddress(address)}
                </span>
              </div>
              <div className="wallet-dropdown-actions">
                <button
                  type="button"
                  className="wallet-dropdown-item"
                  role="menuitem"
                  onClick={handleCopyAddress}
                >
                  <PhosphorIcon name={copied ? 'check' : 'copy'} size={16} />
                  <span>{copied ? 'Copied to clipboard' : 'Copy address'}</span>
                </button>
                <a
                  className="wallet-dropdown-item"
                  role="menuitem"
                  href={`https://stellar.expert/explorer/testnet/account/${address}`}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => setWalletDropdownOpen(false)}
                >
                  <PhosphorIcon name="globe" size={16} />
                  <span>View on Explorer</span>
                </a>
                <button
                  type="button"
                  className="wallet-dropdown-item is-destructive"
                  role="menuitem"
                  onClick={() => {
                    setWalletDropdownOpen(false);
                    onDisconnect?.();
                  }}
                >
                  <PhosphorIcon name="signOut" size={16} />
                  <span>Disconnect</span>
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="menu-wrap">
          <button
            className="topbar-icon menu-trigger"
            aria-label={menuOpen ? 'Close dashboard menu' : 'Open dashboard menu'}
            title={menuOpen ? 'Close dashboard menu' : 'Open dashboard menu'}
            aria-expanded={menuOpen}
            aria-haspopup="true"
            onClick={() => {
              setNotificationsOpen(false);
              setWalletDropdownOpen(false);
              setMenuOpen(open => !open);
            }}
          >
            <PhosphorIcon name="list" size={22} />
          </button>
          {menuOpen && (
            <nav className="menu-dropdown" aria-label="Account and information">
              {!previewMode && <button onClick={() => {setMenuOpen(false); onCreate?.();}}>Create market</button>}
              {menuItems.map(item => <Link key={item.to} to={item.to}>{item.label}</Link>)}
              <button onClick={onActivity}>Activity</button>
            </nav>
          )}
        </div>
      </div>
    </header>
  );
}
