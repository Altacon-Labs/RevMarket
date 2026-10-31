export default function SkeletonCard({variant = 'regular'}) {
  const isLive = variant === 'live';
  return (
    <article className={`market-card skeleton-card${isLive ? ' market-card-live' : ''}`} aria-hidden="true">
      <div className="skeleton-line skeleton-avatar-row">
        <div className="skeleton-circle" />
        <div className="skeleton-pill" />
      </div>
      <div className="market-card-body">
        <div className="skeleton-line skeleton-subtext" style={{width: '40%', marginTop: '12px'}} />
        <div className="skeleton-line skeleton-title" style={{width: '90%', height: '22px', margin: '8px 0'}} />
        <div className="skeleton-line skeleton-title" style={{width: '70%', height: '22px', marginBottom: '12px'}} />
        <div className="skeleton-line skeleton-subtext" style={{width: '50%', marginBottom: '16px'}} />
      </div>
      {!isLive && (
        <div className="skeleton-button-row">
          <div className="skeleton-btn" />
          <div className="skeleton-btn" />
        </div>
      )}
    </article>
  );
}

