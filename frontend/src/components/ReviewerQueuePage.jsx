import {useEffect, useState} from 'react';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';
import {getCurrentSession, getDraft, getReviewQueue, submitReview} from '../lib/backend.mjs';
import {
  buildReviewPayload,
  decisionAvailability,
  decisionErrorFeedback,
  formatUtcSeconds,
  revisionRuleSummary,
} from '../lib/review-workflow.mjs';

function RevisionRules({revision}) {
  const rules = revisionRuleSummary(revision);
  return (
    <section aria-label="Saved revision rules" className="form-note" style={{display: 'grid', gap: '6px', padding: '12px 14px'}}>
      <div style={{display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap'}}>
        <strong style={{color: '#f2f4f6'}}>{rules.question || 'Untitled draft'}</strong>
        <span className="status-pill">Revision #{rules.revisionNumber || '?'} · ID {rules.revisionId ?? '?'}</span>
      </div>
      <dl style={{display: 'grid', gap: '4px', margin: 0, fontSize: '12px', lineHeight: '18px'}}>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>YES rule: </dt><dd style={{display: 'inline', margin: 0}}>{rules.yesRule || 'Missing'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>NO rule: </dt><dd style={{display: 'inline', margin: 0}}>{rules.noRule || 'Missing'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Sources: </dt><dd style={{display: 'inline', margin: 0}}>{rules.sources.length ? rules.sources.join(' · ') : 'Missing'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Unavailable data: </dt><dd style={{display: 'inline', margin: 0}}>{rules.unavailableDataRule || 'Missing'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Trading close: </dt><dd style={{display: 'inline', margin: 0}}>{rules.tradingClose}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Observation: </dt><dd style={{display: 'inline', margin: 0}}>{rules.observationTime}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Resolution deadline: </dt><dd style={{display: 'inline', margin: 0}}>{rules.resolutionDeadline}</dd></div>
      </dl>
    </section>
  );
}

export default function ReviewerQueuePage() {
  const [session, setSession] = useState(null);
  const [queue, setQueue] = useState([]);
  const [selected, setSelected] = useState(null);
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [expiryInput, setExpiryInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [queueNotice, setQueueNotice] = useState('');

  async function loadQueue() {
    setBusy(true);
    setError('');
    let nextSession = null;
    try {
      nextSession = await getCurrentSession();
      setSession(nextSession);
    } catch (err) {
      setSession(null);
      setError(decisionErrorFeedback(err));
    }

    if (nextSession && !(nextSession.canReviewQueue || nextSession.isActiveReviewer || nextSession.isSuperAdmin)) {
      setQueue([]);
      setQueueNotice('Your session can view markets but does not have reviewer queue access.');
      setBusy(false);
      return;
    }

    try {
      const rows = await getReviewQueue();
      setQueue(rows);
      setQueueNotice(rows.length ? '' : 'No submitted drafts are waiting for review.');
    } catch (err) {
      setQueue([]);
      setError(decisionErrorFeedback(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadQueue();
  }, []);

  async function inspect(draftId) {
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await getDraft(draftId);
      const revision = result?.revisions?.[0];
      if (!revision || !result?.draft) throw new Error('This queue item has no readable saved revision.');
      setSelected({draft: result.draft, revision, reviews: result.reviews || []});
      setDecision('');
      setReason('');
      setExpiryInput('');
    } catch (err) {
      setSelected(null);
      setError(decisionErrorFeedback(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitDecision(event) {
    event.preventDefault();
    if (!selected) return;
    let payload;
    try {
      payload = buildReviewPayload({decision, reason, expiryInput, expectedRevisionId: selected.revision.id});
    } catch (err) {
      setError(err.message);
      return;
    }
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await submitReview(selected.draft.id, payload);
      setSuccess(`Decision saved: ${result.status || payload.decision} for revision #${selected.revision.revisionNumber}.`);
      await loadQueue();
      const refreshed = await getDraft(selected.draft.id);
      setSelected(previous => previous && ({
        ...previous,
        draft: refreshed.draft || previous.draft,
        reviews: refreshed.reviews || previous.reviews,
      }));
    } catch (err) {
      setError(decisionErrorFeedback(err));
    } finally {
      setBusy(false);
    }
  }

  const availability = decisionAvailability(session, selected?.draft || {});

  return (
    <>
      <div className="page-heading">
        <div><p className="eyebrow">REVIEW WORKSPACE</p><h1>Reviewer queue</h1></div>
        <button className="button button-quiet" disabled={busy} onClick={loadQueue}>Refresh</button>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {success && <p className="status-message" role="status">{success}</p>}

      <div className="activity-layout">
        <section className="workspace-panel" aria-label="Submitted draft queue">
          <div className="panel-heading"><div><h2>Submitted drafts</h2><p>Open a saved revision before deciding.</p></div></div>
          {queueNotice && <p className="form-note" role="status">{queueNotice}</p>}
          <div style={{display: 'grid', gap: '8px'}}>
            {queue.map(item => (
              <div key={item.id} className="form-note" style={{display: 'grid', gap: '6px', padding: '10px 12px'}}>
                <strong style={{color: '#f2f4f6'}}>#{item.id} · {item.question || 'Untitled draft'}</strong>
                <p className="form-note" style={{margin: 0}}>Revision #{item.revisionNumber || '?'} · {item.ownerWallet} · {formatUtcSeconds(item.updatedAt)}</p>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => inspect(item.id)}
                >
                  Inspect saved revision
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="workspace-panel" aria-label="Review decision">
          <div className="panel-heading"><div><h2>Decision</h2><p>The exact saved revision ID is sent with every decision.</p></div></div>
          {!selected && <p className="form-note" role="status">Select a queued draft to load its saved rules.</p>}
          {selected && <>
            <RevisionRules revision={selected.revision} />
            {availability.reason && <p className="form-note" role="status">{availability.reason}</p>}
            <form className="dialog-form" onSubmit={submitDecision} style={{padding: 0}}>
              <label>Decision
                <select value={decision} onChange={event => setDecision(event.target.value)} disabled={!availability.canDecide || busy}>
                  <option value="">Choose a decision…</option>
                  <option value="changes_requested">Request changes</option>
                  <option value="rejected">Reject</option>
                  <option value="approved">Approve</option>
                </select>
              </label>
              <label>Reason
                <textarea rows="3" value={reason} onChange={event => setReason(event.target.value)} disabled={!availability.canDecide || busy} style={{width: '100%', resize: 'vertical'}} placeholder="Explain the decision for the creator." />
              </label>
              {decision === 'approved' && <label>Approval expiry (UTC)
                <input type="datetime-local" value={expiryInput} onChange={event => setExpiryInput(event.target.value)} disabled={!availability.canDecide || busy} />
              </label>}
              <button className="button button-primary" disabled={!availability.canDecide || busy || !decision}>
                {busy ? 'Saving…' : 'Submit decision'}
              </button>
            </form>
          </>}
        </section>
      </div>
      <p className="form-note"><PhosphorIcon name="info" size={14} /> Queue access and decision rights are checked separately by the server. A super-admin may read but not decide.</p>
    </>
  );
}
