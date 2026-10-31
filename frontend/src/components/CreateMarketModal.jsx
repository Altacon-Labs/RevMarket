import {useState} from 'react';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';
import {createDraft, requestAiAssist} from '../lib/backend.mjs';

export default function CreateMarketModal({busy, previewMode, onClose, onCreate}) {
  const [kind, setKind] = useState('event');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState(null);

  async function handleAiAssist() {
    if (!question.trim()) {
      setError('Please provide an initial question to analyze with AI.');
      return;
    }
    setError('');
    setAiLoading(true);
    try {
      const closesAt = Math.floor(Date.now() / 1000) + 86400 * 7;
      const draft = await createDraft({
        question: question.trim(),
        category: kind,
        tradingClose: closesAt,
        origin: 'manual'
      });
      const res = await requestAiAssist(draft.id);
      setAiSuggestions(res.suggestions);
    } catch (err) {
      setError(err.message || 'AI assistance request failed');
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
    const data = new FormData(event.currentTarget);
    try {
      const selectedFile = data.get('imageFile');
      const imageFile = selectedFile instanceof File && selectedFile.size > 0 ? selectedFile : null;
      if (kind === 'event' && !imageFile) throw new Error('Choose an image for this event market.');
      if (imageFile && imageFile.size > 5 * 1024 * 1024) throw new Error('Choose an image smaller than 5 MB.');
      await onCreate({kind, question: data.get('question'), asset: data.get('asset'), target: data.get('target'), closes: data.get('closes'), descriptionCid: data.get('descriptionCid'), imageFile});
    } catch (submitError) {
      setError(submitError.message);
    }
  }
  return <div className="dialog-backdrop" onMouseDown={event => {if (event.target === event.currentTarget) onClose();}}>
    <section className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="create-market-title">
      <div className="dialog-heading"><div><p className="eyebrow">NEW PREDICTION</p><h2 id="create-market-title">Create a market</h2></div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><PhosphorIcon name="close" /></button></div>
      <form className="dialog-form" onSubmit={submit}>
        <label>Market type<select value={kind} onChange={event => setKind(event.target.value)}><option value="event">Event</option><option value="price">Price</option></select></label>
        {kind === 'event' && <div>
          <label>Question
            <div style={{display: 'flex', gap: '8px', marginTop: '4px'}}>
              <input name="question" value={question} onChange={e => setQuestion(e.target.value)} required maxLength="512" placeholder="Use a precise, verifiable yes/no question" style={{flex: 1}} />
              <button type="button" className="button button-secondary" disabled={aiLoading || busy} onClick={handleAiAssist} style={{whiteSpace: 'nowrap'}}>
                {aiLoading ? 'Analyzing…' : 'Improve with AI'}
              </button>
            </div>
          </label>
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
        <label>Market artwork{kind === 'event' ? <span className="field-optional">Required · max 5 MB</span> : <span className="field-optional">Optional · token art used by default</span>}<input name="imageFile" type="file" accept="image/jpeg,image/png,image/webp" required={kind === 'event'} /></label>
        <p className="form-note">Artwork uploads are pinned by the backend; an off-chain Freighter sign-in may be requested. Only the image CID is stored on-chain.</p>
        <label>Description CID <span className="field-optional">Optional</span><input name="descriptionCid" maxLength="128" /></label>
        <p className="form-note">Price markets use the first post-close observation from three sources. Event markets require configured evidence providers.</p>
        {previewMode && <p className="form-note">Read-only market preview.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || previewMode}>{previewMode ? 'Preview only' : busy ? 'Submitting…' : 'Create on testnet'}</button></div>
      </form>
    </section>
  </div>;
}