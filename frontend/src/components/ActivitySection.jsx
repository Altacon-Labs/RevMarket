import PhosphorIcon from '../icons/PhosphorIcon.jsx';

export function ActivitySection({id, title, icon, status, children}) {
  return <section className="activity-section" aria-labelledby={id}>
    <div className="activity-section-heading">
      <h2 id={id}><PhosphorIcon name={icon} size={20} />{title}</h2>
      {status && <span className="badge">{status}</span>}
    </div>
    {children}
  </section>;
}

export function ActivityEmptyState({icon, title, description, action}) {
  return <div className="activity-empty-state" role="status">
    <span className="empty-icon"><PhosphorIcon name={icon} size={20} /></span>
    <div>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
    {action && <button className="button button-secondary button-small" type="button" disabled={action.disabled} onClick={action.onClick}>{action.label}</button>}
  </div>;
}