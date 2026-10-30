import PhosphorIcon from '../icons/PhosphorIcon.jsx';

export default function StatsBar({stats}) {
  return <section className="stats-grid" aria-label="Position summary">{stats.map(stat => <article className="stat-card" key={stat.label}><div className="stat-icon"><PhosphorIcon name={stat.icon} size={19} /></div><div className="stat-copy"><p>{stat.label}</p><strong>{stat.value}</strong><small>{stat.detail}</small></div></article>)}</section>;
}