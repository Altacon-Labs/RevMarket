import {useState} from 'react';
import PhosphorIcon from './icons/PhosphorIcon.jsx';

export default function AutomationPanel() {
  const [mode,setMode]=useState('claims');
  const [preview,setPreview]=useState(null);
  const [error,setError]=useState('');
  function previewPlan(event) {
    event.preventDefault();
    const data=new FormData(event.currentTarget);
    setError(''); setPreview(null);
    const expires=new Date(data.get('expiry'));
    if(!Number.isFinite(expires.getTime()) || expires.getTime()<=Date.now()) {
      setError('Choose a future expiry for this draft.'); return;
    }
    setPreview({mode,expiry:expires.toLocaleString()});
  }
  return <section aria-labelledby="automation-title" className="automation-panel">
    <div className="row"><h2 id="automation-title"><PhosphorIcon name="robot" size={24}/>Position automation</h2><span className="badge">Planned · unavailable</span></div>
    <p>Plan automatic winnings and refund claims. Rule-based betting is a later phase. Your current positions and wallet permissions are unchanged.</p>
    <details><summary>Preview an automation plan</summary>
      <form onSubmit={previewPlan} onChange={()=>{setPreview(null);setError('');}}>
        <label>Planned mode<select value={mode} onChange={e=>setMode(e.target.value)}><option value="claims">Claim winnings and eligible refunds</option><option value="betting" disabled>Rule-based betting · later phase</option></select></label>
        <label>Draft authorization expiry<input name="expiry" type="datetime-local" required/></label>
        <button type="submit">Preview draft</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {preview && <p role="status">Draft: automatic claims until {preview.expiry}. Nothing saved or activated.</p>}
      <button disabled type="button" aria-describedby="automation-unavailable">Enable automation · not available</button>
    </details>
    <p id="automation-unavailable" className="muted">Activation requires verified on-chain opt-in, expiry and revocation, plus a background executor. These are contribution tasks. This preview sends no transactions, stores no settings and requests no wallet access. Pausing future automation will not undo existing bets.</p>
  </section>;
}
