import PhosphorIcon from '../icons/PhosphorIcon.jsx';

const groups = [
  {label: 'Markets', items: [{id: 'markets', label: 'All markets', icon: 'grid', count: 'markets'}, {id: 'price', label: 'Price markets', icon: 'chart', count: 'price'}, {id: 'event', label: 'Event markets', icon: 'globe', count: 'event'}]},
  {label: 'Workspace', items: [{id: 'positions', label: 'My positions', icon: 'wallet', count: 'positions'}, {id: 'activity', label: 'Activity', icon: 'pulse'}, {id: 'settings', label: 'Settings', icon: 'gear'}]},
];

export default function Sidebar({activePage, counts, collapsed, address, onNavigate}) {
  const accountLabel = address ? `${address.slice(0, 5)}…${address.slice(-5)}` : 'Wallet not connected';

  return <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="Primary navigation">
    <nav className="sidebar-nav">
      {groups.map(group => <section className="sidebar-group" key={group.label}>
        <p className="sidebar-label">{group.label}</p>
        {group.items.map(item => <button className={`sidebar-link${activePage === item.id ? ' is-active' : ''}`} key={item.id} title={collapsed ? item.label : undefined} aria-label={item.label} aria-current={activePage === item.id ? 'page' : undefined} onClick={() => onNavigate(item.id)}>
          <PhosphorIcon name={item.icon} size={18} />
          <span className="sidebar-link-label">{item.label}</span>
          {item.count && <span className="sidebar-count">{counts[item.count]}</span>}
        </button>)}
      </section>)}
    </nav>
    <div className="sidebar-footer">
      <div className="sidebar-network" title="Network"><span className="network-indicator" /><span className="sidebar-network-label">RevMarket</span></div>
      <button className={`sidebar-profile${activePage === 'profile' ? ' is-active' : ''}`} title={collapsed ? `Profile · ${accountLabel}` : undefined} aria-label={`Profile, ${accountLabel}`} aria-current={activePage === 'profile' ? 'page' : undefined} onClick={() => onNavigate('profile')}>
        <span className="sidebar-profile-avatar"><PhosphorIcon name="user" size={18} /></span>
        <span className="sidebar-profile-copy"><strong>Profile</strong><small>{accountLabel}</small></span>
      </button>
    </div>
  </aside>;
}