import {ActivityEmptyState, ActivitySection} from './ActivitySection.jsx';
import {useVerifiedActivity} from '../lib/useVerifiedActivity.mjs';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';

export default function VerifiedActivitySection({address, network = 'testnet'}) {
  const {status, items, nextCursor, pageInfo, loadingMore, loadMore, refresh, freshness, error} = useVerifiedActivity({address});

  if (!address) {
    return (
      <ActivitySection id="verified-activity" title="Confirmed On-Chain Events" icon="shield-check">
        <ActivityEmptyState
          icon="wallet"
          title="Wallet not connected"
          description="Connect your wallet to view verified on-chain activity and indexer freshness."
        />
      </ActivitySection>
    );
  }

  const isIndexerUnhealthy = freshness && (!freshness.complete || freshness.stale || freshness.lagging || freshness.status === 'uninitialized' || freshness.status === 'unavailable');

  let indexerBadge = null;
  if (freshness) {
    if (freshness.fresh) {
      indexerBadge = <span className="badge badge-success">Indexer Fresh</span>;
    } else if (freshness.stale) {
      indexerBadge = <span className="badge badge-warning">Indexer Stale</span>;
    } else if (freshness.lagging) {
      indexerBadge = <span className="badge badge-warning">Indexer Lagging ({freshness.ledgerLag ?? 0} ledgers)</span>;
    } else if (freshness.status === 'uninitialized') {
      indexerBadge = <span className="badge badge-muted">Indexer Uninitialized</span>;
    } else if (freshness.status === 'unavailable' || freshness.status === 'gap') {
      indexerBadge = <span className="badge badge-danger">Indexer Issue</span>;
    }
  }

  return (
    <ActivitySection id="verified-activity" title="Confirmed On-Chain Events" icon="shield-check" status={indexerBadge}>
      {isIndexerUnhealthy && (
        <div className="indexer-health-banner" role="status">
          <div className="indexer-health-content">
            <PhosphorIcon name="warning-circle" size={18} />
            <div>
              <strong>
                {freshness.status === 'uninitialized'
                  ? 'Indexer is uninitialized'
                  : freshness.status === 'unavailable'
                  ? 'Indexer is unavailable'
                  : freshness.stale
                  ? 'Indexer checkpoint is stale'
                  : freshness.hasGaps
                  ? 'Indexer has recorded ledger gaps'
                  : 'Indexer is lagging behind RPC tip'}
              </strong>
              <p>
                {freshness.status === 'uninitialized'
                  ? 'The contract event indexer has not yet completed its initial sync.'
                  : freshness.stale
                  ? `Last updated ${freshness.ageSeconds}s ago (stale after ${freshness.staleAfterSeconds}s).`
                  : freshness.hasGaps
                  ? `Found ${freshness.gapCount} ledger gap(s). Confirmed events may be temporarily incomplete.`
                  : `Lagging by ${freshness.ledgerLag} ledgers behind latest network tip.`}
              </p>
            </div>
          </div>
          <div className="indexer-health-actions">
            <button className="button button-secondary button-small" type="button" onClick={refresh}>
              <PhosphorIcon name="arrow-clockwise" size={14} /> Retry / Refresh
            </button>
            {freshness.checkpointCursor && (
              <a
                className="button button-text button-small"
                href={`https://stellar.expert/explorer/testnet/contract/${freshness.checkpointCursor}`}
                target="_blank"
                rel="noreferrer"
              >
                View on Explorer <PhosphorIcon name="arrow-square-out" size={12} />
              </a>
            )}
          </div>
        </div>
      )}

      {status === 'loading' && items.length === 0 && (
        <div className="activity-loading" role="status">
          <p>Loading verified on-chain events...</p>
        </div>
      )}

      {error && items.length === 0 && (
        <ActivityEmptyState
          icon="warning"
          title="Could not load verified activity"
          description={error}
          action={{label: 'Retry', onClick: refresh}}
        />
      )}

      {status === 'ready' && items.length === 0 && !error && (
        <ActivityEmptyState
          icon="check-circle"
          title="No confirmed on-chain events"
          description="No confirmed contract events were found for this connected wallet."
          action={{label: 'Refresh', onClick: refresh}}
        />
      )}

      {items.length > 0 && (
        <div className="activity-feed">
          <ul className="activity-list">
            {items.map(item => {
              const txUrl = `https://stellar.expert/explorer/${network}/tx/${item.txHash}`;
              return (
                <li key={item.eventId} className="activity-item verified-item">
                  <div className="activity-item-icon">
                    <PhosphorIcon name="shield-check" size={16} />
                  </div>
                  <div className="activity-item-details">
                    <div className="activity-item-header">
                      <span className="activity-type uppercase">{item.eventType}</span>
                      <span className="badge badge-success">Confirmed Chain Event</span>
                    </div>
                    <div className="activity-meta">
                      <span>Ledger {item.ledger}</span>
                      <span>•</span>
                      <span>{new Date(item.ledgerClosedAt).toLocaleString()}</span>
                      {item.amount && (
                        <>
                          <span>•</span>
                          <span>Amount: {item.amount}</span>
                        </>
                      )}
                    </div>
                    <div className="activity-hash">
                      <a href={txUrl} target="_blank" rel="noreferrer">
                        Tx: {item.txHash.slice(0, 8)}...{item.txHash.slice(-8)} <PhosphorIcon name="arrow-square-out" size={12} />
                      </a>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {pageInfo.hasMore && (
            <div className="activity-pagination">
              <button
                className="button button-secondary button-small"
                type="button"
                disabled={loadingMore}
                onClick={loadMore}
              >
                {loadingMore ? 'Loading more...' : 'Load older confirmed events'}
              </button>
            </div>
          )}
        </div>
      )}
    </ActivitySection>
  );
}
