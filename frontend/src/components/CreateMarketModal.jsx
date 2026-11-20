import {useState} from 'react';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';
import {createDraft, requestAiAssist, updateDraft} from '../lib/backend.mjs';

export default function CreateMarketModal({busy, previewMode, onClose, onCreate}) {
  const [kind, setKind] = useState('event');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState(null);
  const [savedDraft, setSavedDraft] = useState(null);
  const [revisionConflict, setRevisionConflict] = useState(null);

  async function handleAiAssist(overwriteRevisionId) {
    if (!question.trim()) {
      setError('Please provide an initial question to analyze with AI.');
      return;
    }
    setError('');
    setAiLoading(true);
    try {
      const closesAt = Math.floor(Date.now() / 1000) + 86400 * 7;
      const draftData = {
        question: question.trim(),
        category: kind,
        tradingClose: closesAt
      };
      let next;
      if (!savedDraft) {
        const draft = await createDraft({...draftData, origin: 'manual'});
        next = {draftId: draft.id, revisionId: draft.revisionId, revisionNumber: 1};
      } else {
        // Edit the same draft, based on the revision this modal last saved (or, after an explicit
        // overwrite choice, on the newer revision reported by the conflict response).
        const saved = await updateDraft(savedDraft.draftId, draftData, overwriteRevisionId ?? savedDraft.revisionId);
        next = {draftId: savedDraft.draftId, revisionId: saved.revisionId, revisionNumber: saved.revisionNumber};
      }
      setSavedDraft(next);
      setRevisionConflict(null);
      const res = await requestAiAssist(next.draftId);
      setAiSuggestions(res.suggestions);
    } catch (err) {
      // A stale edit keeps the typed text untouched and waits for an explicit choice; nothing retries automatically.
      if (err.status === 409 && err.body?.code === 'revision_conflict') {
        setRevisionConflict({currentRevisionId: err.body.currentRevisionId, currentRevisionNumber: err.body.currentRevisionNumber});
      } else {
        setError(err.message || 'AI assistance request failed');
      }
    } finally {
      setAiLoading(false);
    }
  }

  function applySuggestion(suggestedQ) {
    if (suggestedQ) {
      setQuestion(suggestedQ);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    const formEl = event.currentTarget;
    const data = new FormData(formEl);
    try {
      const selectedFile = data.get('imageFile');
      const imageFile = selectedFile instanceof File && selectedFile.size > 0 ? selectedFile : null;
      if (imageFile && imageFile.size > 5 * 1024 * 1024) throw new Error('Choose an image smaller than 5 MB.');
      await onCreate({
        kind,
        category: data.get('category') || 'general',
        question: data.get('question'),
        asset: data.get('asset'),
        target: data.get('target'),
        closes: data.get('closes'),
        description: data.get('description') || '',
        imageFile
      }, (err) => {
        setError(err.message || 'Creation transaction failed');
      });
    } catch (submitError) {
      setError(submitError.message);
    }
  }
  return <div className="dialog-backdrop" onMouseDown={event => {if (event.target === event.currentTarget) onClose();}}>
    <section className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="create-market-title">
      <div className="dialog-heading"><div><p className="eyebrow">NEW PREDICTION</p><h2 id="create-market-title">Create a market</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><PhosphorIcon name="close" /></button></div>
      <form className="dialog-form" onSubmit={submit}>
        <div className="form-row">
          <label>Market type
            <select value={kind} onChange={event => setKind(event.target.value)}>
              <option value="event">Event</option>
              <option value="price">Price</option>
            </select>
          </label>
          <label>Category
            <select name="category">
              <option value="Crypto">Crypto</option>
              <option value="Sports">Sports</option>
              <option value="Food & Dining">Food & Dining</option>
              <option value="Politics">Politics</option>
              <option value="Tech & Science">Tech & Science</option>
              <option value="Culture & Entertainment">Culture & Entertainment</option>
              <option value="General">General</option>
            </select>
          </label>
        </div>
        {kind === 'event' && <div>
          <label>Question
            <div style={{display: 'flex', gap: '8px', marginTop: '4px'}}>
              <input name="question" value={question} onChange={e => setQuestion(e.target.value)} required maxLength="512" placeholder="Use a precise, verifiable yes/no question" style={{flex: 1}} />
              <button type="button" className="button button-secondary" disabled={aiLoading || busy} onClick={() => handleAiAssist()} style={{whiteSpace: 'nowrap'}}>
                {aiLoading ? 'Analyzing…' : 'Improve with AI'}
              </button>
            </div>
          </label>
          {revisionConflict && <div className="form-note" role="alert" style={{padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', margin: '8px 0'}}>
            <p><PhosphorIcon name="info" size={14} /> This draft was changed in another tab or window (now revision {revisionConflict.currentRevisionNumber}). Your text is still here; nothing was overwritten.</p>
            <button type="button" className="button button-secondary" disabled={aiLoading || busy} onClick={() => handleAiAssist(revisionConflict.currentRevisionId)}>Save my version as a new revision</button>
          </div>}
          {aiSuggestions && <div className="form-note" style={{padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', margin: '8px 0'}}>
            <p><strong>AI Suggestions:</strong></p>
            {aiSuggestions.suggestedQuestion && <p style={{cursor: 'pointer', textDecoration: 'underline'}} onClick={() => applySuggestion(aiSuggestions.suggestedQuestion)}>
              Suggested: {aiSuggestions.suggestedQuestion} (click to apply)
            </p>}
            {aiSuggestions.ambiguityFlags?.length > 0 && <p style={{color: '#ffaa00'}}>
              Ambiguity note: {aiSuggestions.ambiguityFlags.join('; ')}
            </p>}
            {aiSuggestions.suggestedSources?.length > 0 && <p>
              Sources: {aiSuggestions.suggestedSources.join(', ')}
            </p>}
          </div>}
        </div>}
        {kind === 'price' && <div className="form-row"><label>Asset<select name="asset"><option>BTC</option><option>ETH</option><option>XLM</option></select></label><label>Target USD<input name="target" required inputMode="decimal" placeholder="e.g. 85000" /></label></div>}
        <label>Close time<input name="closes" type="datetime-local" required /></label>
        <label>Market artwork <span className="field-optional">Optional · custom image or auto-generated</span><input name="imageFile" type="file" accept="image/jpeg,image/png,image/webp" /></label>
        <p className="form-note">Artwork uploads are pinned by the backend; an off-chain Freighter sign-in may be requested. Only the image CID is stored on-chain.</p>
        <label>Resolution details / Description <span className="field-optional">Optional</span>
          <textarea name="description" rows="3" placeholder="Explain the resolution source, criteria, and evidence rules..." style={{width: '100%', resize: 'vertical'}} />
        </label>
        <p className="form-note">Price markets use the first post-close observation from three sources. Event markets resolve according to stated evidence providers.</p>
        {previewMode && <p className="form-note">Read-only market preview.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || previewMode}>{previewMode ? 'Preview only' : busy ? 'Submitting…' : 'Create on testnet'}</button></div>
      </form>
    </section>
  </div>;
}