import {useEffect, useState} from 'react';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';
import {getDraft, listDrafts} from '../lib/backend.mjs';

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Submitted',
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  approved: 'Approved',
  confirmed: 'Confirmed',
  deployed: 'Deployed',
};

const EDITABLE_STATUSES = new Set(['draft', 'changes_requested']);

function formatDate(epochSeconds) {
  if (!epochSeconds) return '';
  return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default function MyDraftsPanel({onSelectDraft, onClose}) {
  const [drafts, setDrafts] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [loadingId, setLoadingId] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    listDrafts({signal: controller.signal})
      .then(list => setDrafts(list))
      .catch(err => {
        if (err.name !== 'AbortError') {
          setLoadError(err.message || 'Could not load drafts. Make sure you are signed in.');
        }
      });
    return () => controller.abort();
  }, []);

  async function handleOpen(draft) {
    setLoadingId(draft.id);
    try {
      const full = await getDraft(draft.id);
      // The server returns revisions in descending order; first is the current revision.
      const currentRevision = full.revisions?.[0] ?? null;
      onSelectDraft({
        draft: full.draft,
        revision: currentRevision,
        reviews: full.reviews ?? [],
      });
    } catch (err) {
      setLoadError(err.message || 'Could not load that draft.');
    } finally {
      setLoadingId(null);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section
        className="dialog-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="my-drafts-title"
        style={{maxWidth: '640px'}}
      >
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">CREATOR WORKSPACE</p>
            <h2 id="my-drafts-title">My drafts</h2>
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <PhosphorIcon name="close" />
          </button>
        </div>

        {loadError && (
          <p className="form-error" role="alert" style={{margin: '12px 0'}}>
            {loadError}
          </p>
        )}

        {!drafts && !loadError && (
          <p className="form-note" style={{padding: '24px 0', textAlign: 'center'}}>
            Loading drafts…
          </p>
        )}

        {drafts && drafts.length === 0 && (
          <p className="form-note" style={{padding: '24px 0', textAlign: 'center'}}>
            No drafts yet. Use the market creation form to save a draft without publishing.
          </p>
        )}

        {drafts && drafts.length > 0 && (
          <ul
            style={{
              listStyle: 'none',
              margin: '8px 0 0',
              padding: 0,
              display: 'grid',
              gap: '8px',
            }}
            aria-label="Your drafts"
          >
            {drafts.map(draft => {
              const editable = EDITABLE_STATUSES.has(draft.status);
              return (
                <li
                  key={draft.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto',
                    alignItems: 'center',
                    gap: '12px',
                    padding: '12px 14px',
                    background: 'rgba(255,255,255,0.04)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '8px',
                  }}
                >
                  <div style={{minWidth: 0}}>
                    <p
                      style={{
                        margin: 0,
                        fontWeight: 600,
                        color: '#f2f4f6',
                        fontSize: '14px',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={draft.question || '(no question)'}
                    >
                      {draft.question || <em style={{color: '#6b7280'}}>No question set</em>}
                    </p>
                    <p style={{margin: '2px 0 0', fontSize: '12px', color: '#9ba3af'}}>
                      {STATUS_LABELS[draft.status] ?? draft.status}
                      {' · '}
                      Revision {draft.revisionNumber ?? 1}
                      {' · '}
                      {formatDate(draft.updatedAt ?? draft.createdAt)}
                    </p>
                  </div>
                  <button
                    className="button button-secondary"
                    disabled={loadingId === draft.id}
                    onClick={() => handleOpen(draft)}
                    aria-label={`${editable ? 'Edit' : 'View'} draft: ${draft.question || 'untitled'}`}
                    style={{whiteSpace: 'nowrap', fontSize: '13px', padding: '6px 12px'}}
                  >
                    {loadingId === draft.id
                      ? 'Loading…'
                      : editable
                        ? <><PhosphorIcon name="pencil" size={14} /> Edit</>
                        : <><PhosphorIcon name="eye" size={14} /> View</>
                    }
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="dialog-actions" style={{marginTop: '16px'}}>
          <button className="button button-secondary" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}
