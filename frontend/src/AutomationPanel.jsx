import {useState} from 'react';
import PhosphorIcon from './icons/PhosphorIcon.jsx';
import {ActivitySection} from './components/ActivitySection.jsx';

function localDateTimeValue(date) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export default function AutomationPanel() {
  const [mode,setMode]=useState('claims');
  const [expiry,setExpiry]=useState('');
  const [preview,setPreview]=useState(null);
  const [error,setError]=useState('');
  const minExpiry=localDateTimeValue(new Date());

  function previewPlan(event) {
    event.preventDefault();
    setError(''); setPreview(null);
    const expires=new Date(expiry);
    if(!Number.isFinite(expires.getTime()) || expires.getTime()<=Date.now()) {
      setError('Choose a future expiry for this draft.'); return;
    }
    setPreview({mode,expiry:expires.toLocaleString()});
  }

  function clearDraft() {
    setPreview(null);
    setError('');
  }

  return <ActivitySection id="automation-title" title="Position automation" icon="robot" status="Planned · unavailable">
    <p className="activity-section-copy">Plan automatic winnings and refund claims. Rule-based betting is a later phase. Your current positions and wallet permissions are unchanged.</p>
    <details className="automation-preview">
      <summary>Preview an automation plan</summary>
      <form onSubmit={previewPlan} onChange={clearDraft}>
        <label>Planned mode<select value={mode} onChange={event=>setMode(event.target.value)}><option value="claims">Claim winnings and eligible refunds</option><option value="betting" disabled>Rule-based betting · later phase</option></select></label>
        <label>Draft authorization expiry<input name="expiry" type="datetime-local" min={minExpiry} value={expiry} onChange={event=>setExpiry(event.target.value)} required/><small>Choose a future date and time. This draft is not saved or authorized.</small></label>
        <div className="automation-preview-actions"><button className="button button-primary" type="submit" disabled={!expiry}>Preview draft</button><span>Preview only</span></div>
      </form>
      {error && <p className="automation-feedback is-error" role="alert">{error}</p>}
      {preview && <div className="automation-feedback is-ready" role="status"><span className="automation-feedback-icon"><PhosphorIcon name="info" size={17} /></span><div><strong>Draft preview ready</strong><p>{preview.mode === 'claims' ? 'Claim winnings and eligible refunds' : 'Rule-based betting'} until {preview.expiry}. Nothing has been saved or activated.</p></div></div>}
    </details>
    <div className="automation-availability" role="note"><span className="automation-feedback-icon"><PhosphorIcon name="info" size={17} /></span><div><strong>Automation unavailable</strong><p>Activation requires verified on-chain opt-in, expiry and revocation, plus a background executor. This preview sends no transactions and stores no settings.</p></div></div>
    <p className="activity-disclaimer">Pausing future automation will not undo existing bets.</p>
  </ActivitySection>;
}
