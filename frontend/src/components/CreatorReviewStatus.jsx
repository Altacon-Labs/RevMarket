import {useEffect, useState} from 'react';
import {getDraft, getOwnedDrafts} from '../lib/backend.mjs';
import {latestDecision} from '../lib/review-workflow.mjs';

const DECISION_LABELS = {
  changes_requested: 'Changes requested',
  rejected: 'Rejected',
  approved: 'Approved',
};

export default function CreatorReviewStatus() {
  const [rows, setRows] = useState([]);
  const [notice, setNotice] = useState('Loading saved proposal decisions…');
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    try {
      const drafts = await getOwnedDrafts();
      if (!drafts.length) {
        setRows([]);
        setNotice('No saved proposals yet.');
        return;
      }
      const detailed = await Promise.all(drafts.slice(0, 10).map(async draft => {
        const result = await getDraft(draft.id);
        const decision = latestDecision(result.reviews);
        const revision = decision?.revisionId
          ? result.revisions.find(item => item.id === decision.revisionId)
          : result.revisions[0];
        return {
          id: draft.id,
          status: draft.status,
          question: draft.question || result.revisions[0]?.question || 'Untitled draft',
          decision,
          revisionNumber: revision?.revisionNumber ?? null,
        };
      }));
      setRows(detailed);
      setNotice(detailed.some(row => row.decision) ? '' : 'Saved proposals have no review decisions yet.');
    } catch (err) {
      setRows([]);
      setNotice(err.status === 401
        ? 'Sign in to the activity profile to see decisions on your saved proposals.'
        : (err.message || 'Review decisions could not be loaded.'));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <section className="workspace-panel" aria-label="Saved proposal review decisions">
      <div className="panel-heading">
        <div><h2>Review decisions</h2><p>Decision, reason, revision and approval expiry from the server.</p></div>
        <button className="button button-quiet" disabled={busy} onClick={load}>Refresh</button>
      </div>
      {notice && <p className="form-note" role="status">{notice}</p>}
      <div style={{display: 'grid', gap: '8px'}}>
        {rows.filter(row => row.decision).map(row => (
          <article key={row.id} className="form-note" style={{display: 'grid', gap: '4px', padding: '10px 12px'}}>
            <strong style={{color: '#f2f4f6'}}>#{row.id} · {row.question}</strong>
            <p className="form-note" style={{margin: 0}}>
              Status <strong>{row.status}</strong> · Decision <strong>{DECISION_LABELS[row.decision.decision] || row.decision.decision}</strong>
              {' · '}Revision #{row.revisionNumber ?? row.decision.revisionId ?? '?'}
            </p>
            <p className="form-note" style={{margin: 0}}>Reason: {row.decision.reason || 'No reason provided.'}</p>
            {row.decision.decision === 'approved' && (
              <p className="form-note" style={{margin: 0}}>Approval expiry: {row.decision.expiryLabel}</p>
            )}
            <p className="form-note" style={{margin: 0}}>Reviewer: {row.decision.reviewerWallet || 'Unknown'}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
