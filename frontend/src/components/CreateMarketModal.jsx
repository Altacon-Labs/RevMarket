import {useState} from 'react';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';
import {
  buildDraftReviewSummary,
  createDraft,
  pinCollateralForDraft,
  requestAiAssist,
  resolveCollateralIdentity,
  resolveModalCollateralConfig,
} from '../lib/backend.mjs';

export {resolveModalCollateralConfig};

export function CollateralReviewSummary({
  revision,
  fixtureMode = false,
  allowlist,
  catalog,
}) {
  const summary = buildDraftReviewSummary(revision, {fixtureMode, allowlist, catalog});
  const badgeText = !summary.isAvailable
    ? 'Unavailable · Cannot auto-replace'
    : summary.isFixture
      ? 'Stellar Testnet · Fixture'
      : summary.isLegacy
        ? 'Stellar Testnet · Legacy "native"'
        : 'Stellar Testnet · Verified SAC';

  return (
    <section
      className="form-note"
      aria-label="Proposal collateral review summary"
      style={{
        padding: '12px 14px',
        background: !summary.isAvailable ? 'rgba(240, 91, 101, 0.08)' : 'rgba(54, 152, 244, 0.07)',
        border: !summary.isAvailable ? '1px solid rgba(240, 91, 101, 0.35)' : '1px solid rgba(54, 152, 244, 0.24)',
        borderRadius: '10px',
        display: 'grid',
        gap: '6px',
      }}
    >
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap'}}>
        <strong style={{color: '#f2f4f6', fontSize: '12px'}}>
          Review summary (Creator &amp; Reviewer revision #{summary.revisionNumber})
        </strong>
        <span
          className="status-pill"
          style={{
            borderColor: !summary.isAvailable ? '#f05b65' : summary.isFixture ? '#3698f4' : '#28c881',
            color: !summary.isAvailable ? '#ff9399' : summary.isFixture ? '#83c8ff' : '#74dfab',
          }}
        >
          {badgeText}
        </span>
      </div>
      <div style={{display: 'grid', gap: '4px', fontSize: '12px', lineHeight: '18px'}}>
        <div>
          <span>Collateral asset: </span>
          <strong style={{color: '#f2f4f6'}}>
            {summary.isAvailable
              ? (summary.isNative ? 'XLM' : `${summary.code} (${summary.issuerShort})`)
              : summary.shortAssetDisplay}
          </strong>
          {summary.isFixture && <span style={{color: '#83c8ff'}}> · Testnet synthetic 7-decimal asset</span>}
        </div>
        <div>
          <span>Issuer identity: </span>
          <code style={{color: '#d7dce0', wordBreak: 'break-all'}}>
            {summary.isNative
              ? 'Native (Stellar Lumens — no issuer)'
              : (summary.issuer || 'Unverified / unavailable')}
          </code>
        </div>
        <div>
          <span>SEP-11 identity: </span>
          <code style={{color: '#d7dce0', wordBreak: 'break-all'}}>
            {summary.sep11 || `Unverified (${summary.storedCollateral || 'none'})`}
          </code>
        </div>
        <div>
          <span>Pinned contract (draft.collateral): </span>
          {summary.isLegacy ? (
            <code style={{color: '#d7dce0', wordBreak: 'break-all'}}>
              {summary.storedCollateral} → {summary.pinnedContractId}
            </code>
          ) : (
            <code style={{color: '#d7dce0', wordBreak: 'break-all'}}>
              {summary.pinnedContractId || summary.storedCollateral}
            </code>
          )}
        </div>
      </div>
      {summary.warning && (
        <p
          className={!summary.isAvailable ? 'form-error' : 'form-note'}
          role={!summary.isAvailable ? 'alert' : 'status'}
          style={{margin: '2px 0 0', lineHeight: '18px'}}
        >
          {summary.warning}
        </p>
      )}
    </section>
  );
}

export default function CreateMarketModal({
  busy,
  previewMode,
  onClose,
  onCreate,
  fixtureMode: fixtureModeProp,
  collateralAllowlist,
  initialDraft = null,
}) {
  const config = resolveModalCollateralConfig({
    fixtureMode: fixtureModeProp,
    collateralAllowlist,
    initialDraft,
  });
  const {fixtureMode, catalog} = config;

  const [kind, setKind] = useState('event');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState(() => config.initialDraft?.question || '');
  const [selectedCollateral, setSelectedCollateral] = useState(() => config.initialCollateral);
  const [savedRevision, setSavedRevision] = useState(() => config.initialDraft || null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState(null);

  const resolvedCollateral = resolveCollateralIdentity(selectedCollateral, {
    fixtureMode,
    allowlist: collateralAllowlist,
    catalog,
  });

  const duplicateCodesInCatalog = new Set(
    catalog
      .map(entry => entry.code)
      .filter((code, index, list) => list.indexOf(code) !== index)
  );

  const activeRevisionForSummary = {
    ...(savedRevision || {}),
    question: question.trim() || savedRevision?.question || '',
    category: kind,
    collateral: selectedCollateral,
    revisionNumber: savedRevision?.revisionNumber || 1,
  };

  async function handleAiAssist() {
    if (!question.trim()) {
      setError('Please provide an initial question to analyze with AI.');
      return;
    }
    setError('');
    let pinnedCollateral;
    try {
      pinnedCollateral = pinCollateralForDraft(selectedCollateral, {
        fixtureMode,
        allowlist: collateralAllowlist,
        catalog,
      });
    } catch (collateralErr) {
      setError(collateralErr.message);
      return;
    }
    setAiLoading(true);
    try {
      const closesAt = Math.floor(Date.now() / 1000) + 86400 * 7;
      const draft = await createDraft(
        {
          question: question.trim(),
          category: kind,
          tradingClose: closesAt,
          collateral: pinnedCollateral,
          origin: 'manual',
        },
        {
          fixtureMode,
          allowlist: collateralAllowlist,
          catalog,
        },
      );
      setSelectedCollateral(pinnedCollateral);
      setSavedRevision({
        id: draft.id,
        revisionId: draft.revisionId,
        revisionNumber: 1,
        contentHash: draft.contentHash,
        question: question.trim(),
        category: kind,
        collateral: pinnedCollateral,
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
    const formEl = event.currentTarget;
    const data = new FormData(formEl);
    try {
      const pinnedCollateral = pinCollateralForDraft(selectedCollateral, {
        fixtureMode,
        allowlist: collateralAllowlist,
        catalog,
      });
      const verifiedIdentity = resolveCollateralIdentity(pinnedCollateral, {
        fixtureMode,
        allowlist: collateralAllowlist,
        catalog,
      });
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
        collateral: pinnedCollateral,
        collateralIdentity: verifiedIdentity,
        imageFile,
      }, (err) => {
        setError(err.message || 'Creation transaction failed');
      });
    } catch (submitError) {
      setError(submitError.message);
    }
  }

  return <div className="dialog-backdrop" onMouseDown={event => {if (event.target === event.currentTarget) onClose();}}>
    <section className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="create-market-title">
      <div className="dialog-heading">
        <div>
          <p className="eyebrow">
            NEW PREDICTION{fixtureMode ? ' · TESTNET FIXTURE MODE' : ''}
          </p>
          <h2 id="create-market-title">Create a market</h2>
        </div>
        <button className="icon-button" aria-label="Close dialog" onClick={onClose}><PhosphorIcon name="close" /></button>
      </div>
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
        <div>
          <label>
            <span>
              Collateral asset (Stellar Testnet)
              {fixtureMode && <span className="field-optional">Testnet synthetic fixtures enabled</span>}
            </span>
            <select
              name="collateral"
              aria-label="Collateral asset"
              value={selectedCollateral}
              onChange={event => {
                setSelectedCollateral(event.target.value);
                setError('');
              }}
            >
              {(!resolvedCollateral.available || resolvedCollateral.legacy) && (
                <option value={selectedCollateral}>
                  {resolvedCollateral.optionLabel}
                </option>
              )}
              {catalog.map(entry => (
                <option key={entry.contractId} value={entry.contractId}>
                  {entry.optionLabel}
                </option>
              ))}
            </select>
          </label>
          {duplicateCodesInCatalog.size > 0 && (
            <p className="form-note" style={{marginTop: '6px', lineHeight: '18px'}}>
              Multiple Testnet assets share the code <strong>{[...duplicateCodesInCatalog].join(', ')}</strong>. Verify the exact SEP-11 issuer G-address and derived Stellar Asset Contract C-address below.
            </p>
          )}
        </div>
        {kind === 'event' && <div>
          <label>Question
            <div style={{display: 'flex', gap: '8px', marginTop: '4px'}}>
              <input name="question" value={question} onChange={e => setQuestion(e.target.value)} required maxLength="512" placeholder="Use a precise, verifiable yes/no question" style={{flex: 1}} />
              <button type="button" className="button button-secondary" disabled={aiLoading || busy || !resolvedCollateral.available} onClick={handleAiAssist} style={{whiteSpace: 'nowrap'}}>
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
        <label>Market artwork <span className="field-optional">Optional · custom image or auto-generated</span><input name="imageFile" type="file" accept="image/jpeg,image/png,image/webp" /></label>
        <p className="form-note">Artwork uploads are pinned by the backend; an off-chain Freighter sign-in may be requested. Only the image CID is stored on-chain.</p>
        <label>Resolution details / Description <span className="field-optional">Optional</span>
          <textarea name="description" rows="3" placeholder="Explain the resolution source, criteria, and evidence rules..." style={{width: '100%', resize: 'vertical'}} />
        </label>
        <CollateralReviewSummary
          revision={activeRevisionForSummary}
          fixtureMode={fixtureMode}
          allowlist={collateralAllowlist}
          catalog={catalog}
        />
        <p className="form-note">Price markets use the first post-close observation from three sources. Event markets resolve according to stated evidence providers.</p>
        {previewMode && <p className="form-note">Read-only market preview.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" className="button button-secondary" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || previewMode}>{previewMode ? 'Preview only' : busy ? 'Submitting…' : 'Create on testnet'}</button></div>
      </form>
    </section>
  </div>;
}
