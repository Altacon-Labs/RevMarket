import {useState} from 'react';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';
import {
  buildDraftReviewSummary,
  createDraft,
  isAiAssistResultStale,
  pinCollateralForDraft,
  requestAiAssist,
  resolveCollateralIdentity,
  resolveModalCollateralConfig,
  updateDraft,
} from '../lib/backend.mjs';
import MyDraftsPanel from './MyDraftsPanel.jsx';

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

// Convert a unix epoch seconds timestamp to a datetime-local input value.
function epochToDatetimeLocal(epochSeconds) {
  if (!epochSeconds) return '';
  const d = new Date(epochSeconds * 1000);
  // Format as YYYY-MM-DDTHH:MM (browser-compatible datetime-local value)
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

  // ---- Form state ----
  const [kind, setKind] = useState(() => {
    // Rehydrate kind from initialDraft metadata if present
    return config.initialDraft?.metadata?.kind || 'event';
  });
  const [category, setCategory] = useState(() => config.initialDraft?.category || 'General');
  const [question, setQuestion] = useState(() => config.initialDraft?.question || '');
  const [closesAt, setClosesAt] = useState(() =>
    config.initialDraft?.tradingClose
      ? epochToDatetimeLocal(config.initialDraft.tradingClose)
      : ''
  );
  const [yesRule, setYesRule] = useState(() => config.initialDraft?.yesRule || '');
  const [noRule, setNoRule] = useState(() => config.initialDraft?.noRule || '');
  const [equalityRule, setEqualityRule] = useState(() => config.initialDraft?.equalityRule || '');
  const [sources, setSources] = useState(() => {
    const raw = config.initialDraft?.sourcesJson || config.initialDraft?.sources;
    if (Array.isArray(raw)) return raw.join('\n');
    if (typeof raw === 'string') {
      try { return JSON.parse(raw).join('\n'); } catch { return raw; }
    }
    return '';
  });
  const [fallbackRule, setFallbackRule] = useState(() => config.initialDraft?.fallbackRule || '');
  const [unavailableDataRule, setUnavailableDataRule] = useState(() => config.initialDraft?.unavailableDataRule || '');
  const [selectedCollateral, setSelectedCollateral] = useState(() => config.initialCollateral);

  // ---- Draft / AI state ----
  const [error, setError] = useState('');
  const [savedRevision, setSavedRevision] = useState(() => config.initialDraft || null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState(null);
  const [savedDraft, setSavedDraft] = useState(() =>
    config.initialDraft?.id
      ? {draftId: config.initialDraft.id, revisionId: config.initialDraft.revisionId, revisionNumber: config.initialDraft.revisionNumber ?? 1, contentHash: config.initialDraft.contentHash}
      : null
  );
  const [revisionConflict, setRevisionConflict] = useState(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [showMyDrafts, setShowMyDrafts] = useState(false);
  // When in read-only mode (non-editable status), show comparison details
  const [readOnlyStatus, setReadOnlyStatus] = useState(() => {
    if (config.initialDraft?.status && !['draft', 'changes_requested'].includes(config.initialDraft.status)) {
      return config.initialDraft.status;
    }
    return null;
  });

  const draftIsEditable = !readOnlyStatus;

  const aiSuggestionsStale = aiSuggestions && isAiAssistResultStale(
    aiSuggestions,
    savedDraft,
    {question: question.trim(), category: kind, collateral: selectedCollateral},
  );

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

  // Build the draft body from the current form state.
  function buildDraftData() {
    const tradingCloseMs = closesAt ? new Date(closesAt).getTime() : 0;
    const tradingClose = tradingCloseMs > 0 ? Math.floor(tradingCloseMs / 1000) : Math.floor(Date.now() / 1000) + 86400 * 7;
    const sourceList = sources
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    return {
      question: question.trim(),
      category,
      tradingClose,
      yesRule: yesRule.trim(),
      noRule: noRule.trim(),
      equalityRule: equalityRule.trim(),
      sources: sourceList,
      fallbackRule: fallbackRule.trim(),
      unavailableDataRule: unavailableDataRule.trim(),
      collateral: selectedCollateral,
      metadata: {kind},
    };
  }

  // ---- Manual save (no AI) ----
  async function handleSaveDraft() {
    if (!question.trim()) {
      setError('Enter a question before saving.');
      return;
    }
    setError('');
    setDraftSaved(false);
    setSavingDraft(true);
    try {
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
      const draftData = {...buildDraftData(), collateral: pinnedCollateral};
      const collateralOptions = {fixtureMode, allowlist: collateralAllowlist, catalog};

      let next;
      if (!savedDraft) {
        const draft = await createDraft({...draftData, origin: 'manual'}, collateralOptions);
        next = {draftId: draft.id, revisionId: draft.revisionId, revisionNumber: 1, contentHash: draft.contentHash};
      } else {
        const saved = await updateDraft(savedDraft.draftId, draftData, {
          ...collateralOptions,
          expectedRevisionId: savedDraft.revisionId,
        });
        next = {draftId: savedDraft.draftId, revisionId: saved.revisionId, revisionNumber: saved.revisionNumber, contentHash: saved.contentHash};
      }
      setSavedDraft(next);
      setRevisionConflict(null);
      setSavedRevision({
        id: next.draftId,
        revisionId: next.revisionId,
        revisionNumber: next.revisionNumber,
        contentHash: next.contentHash,
        question: question.trim(),
        category,
        collateral: pinnedCollateral,
        yesRule: yesRule.trim(),
        noRule: noRule.trim(),
        equalityRule: equalityRule.trim(),
        fallbackRule: fallbackRule.trim(),
        unavailableDataRule: unavailableDataRule.trim(),
        tradingClose: draftData.tradingClose,
      });
      setDraftSaved(true);
    } catch (err) {
      if (err.status === 409 && err.body?.code === 'revision_conflict') {
        setRevisionConflict({
          currentRevisionId: err.body.currentRevisionId,
          currentRevisionNumber: err.body.currentRevisionNumber,
        });
      } else {
        setError(err.message || 'Draft save failed.');
      }
    } finally {
      setSavingDraft(false);
    }
  }

  // After a 409 conflict: save the user's current text as a new revision on top of the server's latest.
  async function handleSaveOverConflict() {
    if (!revisionConflict) return;
    setError('');
    setDraftSaved(false);
    setSavingDraft(true);
    try {
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
      const draftData = {...buildDraftData(), collateral: pinnedCollateral};
      const collateralOptions = {fixtureMode, allowlist: collateralAllowlist, catalog};
      const saved = await updateDraft(savedDraft.draftId, draftData, {
        ...collateralOptions,
        expectedRevisionId: revisionConflict.currentRevisionId,
      });
      const next = {draftId: savedDraft.draftId, revisionId: saved.revisionId, revisionNumber: saved.revisionNumber, contentHash: saved.contentHash};
      setSavedDraft(next);
      setRevisionConflict(null);
      setSavedRevision({
        id: next.draftId,
        revisionId: next.revisionId,
        revisionNumber: next.revisionNumber,
        contentHash: next.contentHash,
        question: question.trim(),
        category,
        collateral: pinnedCollateral,
      });
      setDraftSaved(true);
    } catch (err) {
      setError(err.message || 'Could not save over conflict.');
    } finally {
      setSavingDraft(false);
    }
  }

  // After a 409 conflict: discard local edits and reload the server's latest revision.
  async function handleReloadFromServer() {
    if (!revisionConflict || !savedDraft) return;
    setError('');
    setSavingDraft(true);
    try {
      const {getDraft} = await import('../lib/backend.mjs');
      const full = await getDraft(savedDraft.draftId);
      const rev = full.revisions?.[0];
      if (!rev) { setError('Could not reload draft.'); return; }
      // Rehydrate all form fields from the server revision
      setQuestion(rev.question || '');
      setCategory(rev.category || 'General');
      setKind(rev.metadata?.kind || (typeof rev.metadataJson === 'string' ? (JSON.parse(rev.metadataJson)?.kind || 'event') : 'event'));
      setClosesAt(epochToDatetimeLocal(rev.tradingClose));
      setYesRule(rev.yesRule || '');
      setNoRule(rev.noRule || '');
      setEqualityRule(rev.equalityRule || '');
      const srcList = (() => {
        const raw = rev.sourcesJson || rev.sources;
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
        return [];
      })();
      setSources(srcList.join('\n'));
      setFallbackRule(rev.fallbackRule || '');
      setUnavailableDataRule(rev.unavailableDataRule || '');
      if (rev.collateral) setSelectedCollateral(rev.collateral);
      const next = {draftId: savedDraft.draftId, revisionId: rev.id, revisionNumber: rev.revisionNumber, contentHash: rev.contentHash};
      setSavedDraft(next);
      setSavedRevision({...rev, id: savedDraft.draftId, revisionId: rev.id});
      setRevisionConflict(null);
    } catch (err) {
      setError(err.message || 'Could not reload draft from server.');
    } finally {
      setSavingDraft(false);
    }
  }

  // Open a draft from MyDraftsPanel, rehydrating all fields
  function handleSelectDraft({draft, revision, reviews}) {
    setShowMyDrafts(false);
    if (!revision) return;
    setQuestion(revision.question || '');
    setCategory(revision.category || 'General');
    // Restore kind from metadata_json
    const meta = (() => {
      if (revision.metadataJson) {
        try { return JSON.parse(revision.metadataJson); } catch { return {}; }
      }
      return revision.metadata || {};
    })();
    setKind(meta.kind || 'event');
    setClosesAt(epochToDatetimeLocal(revision.tradingClose));
    setYesRule(revision.yesRule || '');
    setNoRule(revision.noRule || '');
    setEqualityRule(revision.equalityRule || '');
    const srcList = (() => {
      const raw = revision.sourcesJson || revision.sources;
      if (Array.isArray(raw)) return raw;
      if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
      return [];
    })();
    setSources(srcList.join('\n'));
    setFallbackRule(revision.fallbackRule || '');
    setUnavailableDataRule(revision.unavailableDataRule || '');
    if (revision.collateral) setSelectedCollateral(revision.collateral);
    const next = {draftId: draft.id, revisionId: revision.id, revisionNumber: revision.revisionNumber, contentHash: revision.contentHash};
    setSavedDraft(next);
    setSavedRevision({...revision, id: draft.id, revisionId: revision.id});
    setRevisionConflict(null);
    setAiSuggestions(null);
    setDraftSaved(false);
    setError('');
    // If draft is not in an editable state, mark read-only
    if (!['draft', 'changes_requested'].includes(draft.status)) {
      setReadOnlyStatus(draft.status);
    } else {
      setReadOnlyStatus(null);
    }
  }

  async function handleAiAssist(overwriteRevisionId) {
    if (!question.trim()) {
      setError('Please provide an initial question to analyze with AI.');
      return;
    }
    setError('');
    setAiSuggestions(null);
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
      // Use the actual form's tradingClose (or +7d if not set), not a hardcoded value.
      const tradingCloseMs = closesAt ? new Date(closesAt).getTime() : 0;
      const tradingClose = tradingCloseMs > 0 ? Math.floor(tradingCloseMs / 1000) : Math.floor(Date.now() / 1000) + 86400 * 7;
      const draftData = {
        question: question.trim(),
        category,
        tradingClose,
        collateral: pinnedCollateral,
        yesRule: yesRule.trim(),
        noRule: noRule.trim(),
        equalityRule: equalityRule.trim(),
        fallbackRule: fallbackRule.trim(),
        unavailableDataRule: unavailableDataRule.trim(),
        metadata: {kind},
      };
      const sourceForm = {
        question: draftData.question,
        category: draftData.category,
        collateral: draftData.collateral,
      };
      const collateralOptions = {fixtureMode, allowlist: collateralAllowlist, catalog};
      let next;
      if (!savedDraft) {
        const draft = await createDraft({...draftData, origin: 'manual'}, collateralOptions);
        next = {draftId: draft.id, revisionId: draft.revisionId, revisionNumber: 1, contentHash: draft.contentHash};
      } else {
        const saved = await updateDraft(savedDraft.draftId, draftData, {
          ...collateralOptions,
          expectedRevisionId: overwriteRevisionId ?? savedDraft.revisionId,
        });
        next = {draftId: savedDraft.draftId, revisionId: saved.revisionId, revisionNumber: saved.revisionNumber, contentHash: saved.contentHash};
      }
      setSavedDraft(next);
      setRevisionConflict(null);
      setSelectedCollateral(pinnedCollateral);
      setSavedRevision({
        id: next.draftId,
        revisionId: next.revisionId,
        revisionNumber: next.revisionNumber,
        contentHash: next.contentHash,
        question: question.trim(),
        category,
        collateral: pinnedCollateral,
      });
      const res = await requestAiAssist(next.draftId, next.revisionId);
      setAiSuggestions({
        ...res,
        expectedDraftId: next.draftId,
        expectedRevisionId: next.revisionId,
        sourceForm,
      });
    } catch (err) {
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
    if (suggestedQ && !aiSuggestionsStale) {
      setQuestion(suggestedQ);
      setAiSuggestions(null);
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
        category: category || 'general',
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

  return <>
    {showMyDrafts && (
      <MyDraftsPanel
        onSelectDraft={handleSelectDraft}
        onClose={() => setShowMyDrafts(false)}
      />
    )}
    <div className="dialog-backdrop" onMouseDown={event => {if (event.target === event.currentTarget) onClose();}}>
      <section className="dialog-panel" role="dialog" aria-modal="true" aria-labelledby="create-market-title">
        <div className="dialog-heading">
          <div>
            <p className="eyebrow">
              NEW PREDICTION{fixtureMode ? ' · TESTNET FIXTURE MODE' : ''}
            </p>
            <h2 id="create-market-title">Create a market</h2>
          </div>
          <div style={{display: 'flex', gap: '8px', alignItems: 'center'}}>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => setShowMyDrafts(true)}
              aria-label="Open my drafts"
              style={{fontSize: '13px', padding: '6px 12px'}}
            >
              <PhosphorIcon name="folder" size={14} /> My drafts
            </button>
            <button className="icon-button" aria-label="Close dialog" onClick={onClose}><PhosphorIcon name="close" /></button>
          </div>
        </div>

        {readOnlyStatus && (
          <div
            className="form-note"
            role="status"
            style={{padding: '8px 12px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', marginBottom: '8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}
          >
            <span>
              <PhosphorIcon name="eye" size={14} /> Viewing draft in <strong>{readOnlyStatus}</strong> status — read-only.
            </span>
            {savedDraft && (
              <button
                type="button"
                className="button button-secondary"
                style={{fontSize: '12px', padding: '4px 8px'}}
                onClick={() => setShowMyDrafts(true)}
              >
                Switch draft
              </button>
            )}
          </div>
        )}

        {savedDraft && !readOnlyStatus && (
          <p className="form-note" style={{fontSize: '12px', margin: '0 0 8px'}}>
            <PhosphorIcon name="floppy-disk" size={12} /> Draft #{savedDraft.draftId} · revision {savedDraft.revisionNumber}
            {draftSaved && <span style={{color: '#28c881', marginLeft: '8px'}}>Saved</span>}
          </p>
        )}

        <form className="dialog-form" onSubmit={submit}>
          <div className="form-row">
            <label>Market type
              <select value={kind} disabled={!draftIsEditable} onChange={event => { setKind(event.target.value); setDraftSaved(false); }}>
                <option value="event">Event</option>
                <option value="price">Price</option>
              </select>
            </label>
            <label>Category
              <select name="category" value={category} disabled={!draftIsEditable} onChange={e => { setCategory(e.target.value); setDraftSaved(false); }}>
                <option value="Crypto">Crypto</option>
                <option value="Sports">Sports</option>
                <option value="Food & Dining">Food &amp; Dining</option>
                <option value="Politics">Politics</option>
                <option value="Tech & Science">Tech &amp; Science</option>
                <option value="Culture & Entertainment">Culture &amp; Entertainment</option>
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
                disabled={!draftIsEditable}
                onChange={event => {
                  setSelectedCollateral(event.target.value);
                  setError('');
                  setDraftSaved(false);
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
                <input
                  name="question"
                  value={question}
                  disabled={!draftIsEditable}
                  onChange={e => { setQuestion(e.target.value); setDraftSaved(false); }}
                  required
                  maxLength="512"
                  placeholder="Use a precise, verifiable yes/no question"
                  style={{flex: 1}}
                />
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={aiLoading || busy || !resolvedCollateral.available || !draftIsEditable}
                  onClick={() => handleAiAssist()}
                  style={{whiteSpace: 'nowrap'}}
                >
                  {aiLoading ? 'Analyzing…' : 'Improve with AI'}
                </button>
              </div>
            </label>
            {revisionConflict && (
              <div className="form-note" role="alert" style={{padding: '10px 12px', background: 'rgba(255,180,0,0.07)', border: '1px solid rgba(255,180,0,0.3)', borderRadius: '6px', margin: '8px 0'}}>
                <p style={{margin: '0 0 8px'}}>
                  <PhosphorIcon name="warning" size={14} /> This draft was edited in another tab or window (now revision {revisionConflict.currentRevisionNumber}). Your text is preserved — nothing was overwritten.
                </p>
                <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={savingDraft || busy}
                    onClick={handleSaveOverConflict}
                  >
                    Save my version as revision {revisionConflict.currentRevisionNumber + 1}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={savingDraft || busy}
                    onClick={handleReloadFromServer}
                  >
                    Reload server revision {revisionConflict.currentRevisionNumber}
                  </button>
                </div>
              </div>
            )}
            {aiSuggestions && <div className="form-note" role="status" style={{padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', margin: '8px 0'}}>
              <p><strong>AI Suggestions · draft revision #{aiSuggestions.sourceRevision.revisionNumber}</strong></p>
              {aiSuggestionsStale && <p className="form-error">
                These suggestions were generated for this revision, but the draft or form has changed since. They cannot be applied to the current values.
              </p>}
              {aiSuggestions.suggestions.suggestedQuestion && <div>
                <p>Suggested: {aiSuggestions.suggestions.suggestedQuestion}</p>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={aiSuggestionsStale}
                  onClick={() => applySuggestion(aiSuggestions.suggestions.suggestedQuestion)}
                >
                  Apply suggestion
                </button>
              </div>}
              {aiSuggestions.suggestions.ambiguityFlags?.length > 0 && <p style={{color: '#ffaa00'}}>
                Ambiguity note: {aiSuggestions.suggestions.ambiguityFlags.join('; ')}
              </p>}
              {aiSuggestions.suggestions.suggestedSources?.length > 0 && <p>
                Sources: {aiSuggestions.suggestions.suggestedSources.join(', ')}
              </p>}
            </div>}
          </div>}
          {kind === 'price' && <div className="form-row"><label>Asset<select name="asset"><option>BTC</option><option>ETH</option><option>XLM</option></select></label><label>Target USD<input name="target" required inputMode="decimal" placeholder="e.g. 85000" /></label></div>}

          <label>Close time
            <input
              name="closes"
              type="datetime-local"
              required
              value={closesAt}
              disabled={!draftIsEditable}
              onChange={e => { setClosesAt(e.target.value); setDraftSaved(false); }}
            />
          </label>

          {/* Resolution rules — shown for event markets so they can be saved in the draft */}
          {kind === 'event' && draftIsEditable && <>
            <label>YES resolution rule <span className="field-optional">Optional · save now, required before submission</span>
              <textarea
                name="yesRule"
                rows="2"
                placeholder="Condition under which the market resolves YES"
                style={{width: '100%', resize: 'vertical'}}
                value={yesRule}
                onChange={e => { setYesRule(e.target.value); setDraftSaved(false); }}
              />
            </label>
            <label>NO resolution rule <span className="field-optional">Optional</span>
              <textarea
                name="noRule"
                rows="2"
                placeholder="Condition under which the market resolves NO"
                style={{width: '100%', resize: 'vertical'}}
                value={noRule}
                onChange={e => { setNoRule(e.target.value); setDraftSaved(false); }}
              />
            </label>
            <label>Equality rule <span className="field-optional">Optional</span>
              <input
                name="equalityRule"
                placeholder="e.g. Resolves NO on exact equality"
                value={equalityRule}
                onChange={e => { setEqualityRule(e.target.value); setDraftSaved(false); }}
              />
            </label>
            <label>Resolution sources <span className="field-optional">Optional · one URL per line</span>
              <textarea
                name="sources"
                rows="3"
                placeholder="https://api.example.com/price&#10;https://api.another.com/spot"
                style={{width: '100%', resize: 'vertical'}}
                value={sources}
                onChange={e => { setSources(e.target.value); setDraftSaved(false); }}
              />
            </label>
            <label>Fallback rule <span className="field-optional">Optional</span>
              <input
                name="fallbackRule"
                placeholder="e.g. Median of remaining active sources"
                value={fallbackRule}
                onChange={e => { setFallbackRule(e.target.value); setDraftSaved(false); }}
              />
            </label>
            <label>Unavailable data rule <span className="field-optional">Optional</span>
              <input
                name="unavailableDataRule"
                placeholder="e.g. Resolves Invalid if fewer than 2 sources report before deadline"
                value={unavailableDataRule}
                onChange={e => { setUnavailableDataRule(e.target.value); setDraftSaved(false); }}
              />
            </label>
          </>}

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
          <div className="dialog-actions">
            <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
            {draftIsEditable && (
              <button
                type="button"
                className="button button-secondary"
                disabled={savingDraft || busy || !question.trim()}
                onClick={handleSaveDraft}
              >
                {savingDraft ? 'Saving…' : draftSaved ? 'Saved ✓' : 'Save draft'}
              </button>
            )}
            <button className="button button-primary" disabled={busy || previewMode || !!readOnlyStatus}>
              {previewMode || readOnlyStatus ? 'Read only' : busy ? 'Submitting…' : 'Create on testnet'}
            </button>
          </div>
        </form>
      </section>
    </div>
  </>;
}
