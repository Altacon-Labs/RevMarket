import {useEffect, useRef, useState} from 'react';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';
import {
  buildDraftReviewSummary,
  createDraft,
  getDraft,
  isAiAssistResultStale,
  listDrafts,
  pinCollateralForDraft,
  requestAiAssist,
  resolveCollateralIdentity,
  resolveModalCollateralConfig,
  submitDraft,
  updateDraft,
  withdrawDraft,
} from '../lib/backend.mjs';
import {
  buildDraftPayload,
  defaultCloseInput,
  draftFieldErrors,
  formFromDraftRevision,
  getDraftActionAvailability,
  parseUtcInput,
  toUtcInput,
  validateDraftSave,
  validateDraftTiming,
} from '../lib/draft-workflow.mjs';

export {resolveModalCollateralConfig};

const LAST_DRAFT_KEY = 'revmarket.creator-draft-id';

function readLastDraftId() {
  try {return localStorage.getItem(LAST_DRAFT_KEY) || '';} catch {return '';}
}

function rememberDraftId(draftId) {
  try {localStorage.setItem(LAST_DRAFT_KEY, String(draftId));} catch { /* storage is optional */ }
}

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

function FieldError({name, errors}) {
  const message = errors?.[name];
  return message
    ? <p className="form-error" id={`${name}-error`} role="alert" style={{margin: '4px 0 0'}}>{message}</p>
    : null;
}

function formatUnix(seconds) {
  const parsed = parseUtcInput(toUtcInput(seconds));
  if (parsed === null) return 'Not set';
  return `${toUtcInput(seconds).replace('T', ' ')} UTC`;
}

export function DraftReviewSummary({status, revisionNumber, form, availability}) {
  const sources = Array.isArray(form.sources)
    ? form.sources
    : String(form.sources || '').split('\n').map(source => source.trim()).filter(Boolean);
  return (
    <section className="form-note" aria-label="Draft review summary" style={{padding: '12px 14px', border: '1px solid rgba(54, 152, 244, 0.24)', borderRadius: '10px', display: 'grid', gap: '6px'}}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap'}}>
        <strong style={{color: '#f2f4f6', fontSize: '12px'}}>Review summary · saved revision #{revisionNumber || 1}</strong>
        <span className="status-pill" style={{borderColor: '#3698f4', color: '#83c8ff'}}>{status || 'draft'}</span>
      </div>
      <dl style={{display: 'grid', gap: '4px', margin: 0, fontSize: '12px', lineHeight: '18px'}}>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Question: </dt><dd style={{display: 'inline', margin: 0}}>{form.question || 'Not set'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>YES rule: </dt><dd style={{display: 'inline', margin: 0}}>{form.yesRule || 'Not set'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>NO rule: </dt><dd style={{display: 'inline', margin: 0}}>{form.noRule || 'Not set'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Sources: </dt><dd style={{display: 'inline', margin: 0}}>{sources.length ? sources.join(' · ') : 'Not set'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Trading close: </dt><dd style={{display: 'inline', margin: 0}}>{form.tradingClose ? formatUnix(form.tradingClose) : 'Not set'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Observation: </dt><dd style={{display: 'inline', margin: 0}}>{form.observationTime ? formatUnix(form.observationTime) : 'Not set'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Resolution deadline: </dt><dd style={{display: 'inline', margin: 0}}>{form.resolutionDeadline ? formatUnix(form.resolutionDeadline) : 'Not set'}</dd></div>
        <div><dt style={{display: 'inline', color: '#9aa7b1'}}>Unavailable data: </dt><dd style={{display: 'inline', margin: 0}}>{form.unavailableDataRule || 'Not set'}</dd></div>
      </dl>
      {availability?.reason && <p className="form-note" role="status" style={{margin: '2px 0 0'}}>{availability.reason}</p>}
    </section>
  );
}

export default function CreateMarketModal({
  busy,
  previewMode,
  escrow = null,
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

  const initialForm = formFromDraftRevision(config.initialDraft || {});
  const [kind, setKind] = useState('event');
  const [error, setError] = useState('');
  const [category, setCategory] = useState(() => config.initialDraft?.category || 'Crypto');
  const [uploadFailed, setUploadFailed] = useState(false);
  const formRef = useRef(null);
  const [question, setQuestion] = useState(() => config.initialDraft?.question || '');
  const [closes, setCloses] = useState(() => initialForm.tradingClose || defaultCloseInput());
  const [draftForm, setDraftForm] = useState(() => ({
    ...initialForm,
    tradingClose: initialForm.tradingClose || defaultCloseInput(),
  }));
  const [fieldErrors, setFieldErrors] = useState({});
  const [drafts, setDrafts] = useState([]);
  const [selectedDraftId, setSelectedDraftId] = useState(readLastDraftId);
  const [draftsNotice, setDraftsNotice] = useState('');
  const [draftBusy, setDraftBusy] = useState(false);
  const [selectedCollateral, setSelectedCollateral] = useState(() => config.initialCollateral);
  const [savedRevision, setSavedRevision] = useState(() => config.initialDraft || null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState(null);
  const [savedDraft, setSavedDraft] = useState(() => config.initialDraft?.id
    ? {
        draftId: config.initialDraft.id,
        revisionId: config.initialDraft.revisionId,
        revisionNumber: config.initialDraft.revisionNumber || 1,
        contentHash: config.initialDraft.contentHash,
        status: config.initialDraft.status || 'draft',
      }
    : null);
  const [revisionConflict, setRevisionConflict] = useState(null);

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

  const draftValues = {
    ...draftForm,
    question,
    category,
    tradingClose: closes,
    collateral: selectedCollateral,
  };
  const draftAvailability = getDraftActionAvailability(savedDraft?.status);
  const {payload: draftPayload} = buildDraftPayload(draftValues, {
    collateral: selectedCollateral,
  });

  const activeRevisionForSummary = {
    ...(savedRevision || {}),
    question: question.trim() || savedRevision?.question || '',
    category: category,
    collateral: selectedCollateral,
    revisionNumber: savedRevision?.revisionNumber || 1,
  };

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
      const closesAt = Math.floor(Date.now() / 1000) + 86400 * 7;
      const draftData = {
        question: question.trim(),
        category: kind,
        tradingClose: closesAt,
        collateral: pinnedCollateral,
      };
      const sourceForm = {
        question: draftData.question,
        category: draftData.category,
        collateral: draftData.collateral,
      };
      const collateralOptions = {
        fixtureMode,
        allowlist: collateralAllowlist,
        catalog,
      };
      let next;
      if (!savedDraft) {
        const draft = await createDraft({...draftData, origin: 'manual'}, collateralOptions);
        next = {draftId: draft.id, revisionId: draft.revisionId, revisionNumber: 1, contentHash: draft.contentHash};
      } else {
        // Edit the same draft, based on the revision this modal last saved (or, after an explicit
        // overwrite choice, on the newer revision reported by the conflict response).
        const saved = await updateDraft(savedDraft.draftId, draftData, {
          ...collateralOptions,
          expectedRevisionId: overwriteRevisionId ?? savedDraft.revisionId,
        });
        next = {draftId: savedDraft.draftId, revisionId: saved.revisionId, revisionNumber: saved.revisionNumber, contentHash: saved.contentHash};
      }
      rememberDraftId(next.draftId);
      setSelectedDraftId(String(next.draftId));
      setSavedDraft({...next, status: 'draft'});
      setFieldErrors({});
      setRevisionConflict(null);
      setSelectedCollateral(pinnedCollateral);
      setSavedRevision({
        id: next.draftId,
        revisionId: next.revisionId,
        revisionNumber: next.revisionNumber,
        contentHash: next.contentHash,
        question: question.trim(),
        category: kind,
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
    if (suggestedQ && !aiSuggestionsStale) {
      setQuestion(suggestedQ);
      setAiSuggestions(null);
    }
  }

  function updateDraftField(name, value) {
    setDraftForm(previous => ({...previous, [name]: value}));
    setFieldErrors(previous => ({...previous, [name]: undefined}));
  }

  async function loadDrafts() {
    try {
      const rows = await listDrafts();
      setDrafts(rows);
      setDraftsNotice(rows.length ? '' : 'No saved proposals yet. Save a draft to revisit it here.');
      return rows;
    } catch (err) {
      setDrafts(err.status === 401 ? [] : drafts);
      setDraftsNotice(err.status === 401
        ? 'Sign in to the activity profile from the sidebar to load saved proposals.'
        : (err.message || 'Saved proposals could not be loaded.'));
      return [];
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      const rows = await loadDrafts();
      const lastId = readLastDraftId();
      if (active && lastId && rows.some(row => String(row.id) === String(lastId))) {
        await openSavedDraft(lastId);
      }
    })();
    return () => {active = false;};
  }, []);

  async function openSavedDraft(draftId) {
    if (!draftId) return;
    setDraftBusy(true);
    setError('');
    rememberDraftId(draftId);
    try {
      const result = await getDraft(draftId);
      const revision = result?.revisions?.[0];
      if (!revision || !result?.draft) throw new Error('The saved proposal has no readable revision.');
      const restored = formFromDraftRevision(revision);
      setQuestion(restored.question);
      setCategory(restored.category || 'Crypto');
      setCloses(restored.tradingClose || defaultCloseInput());
      setDraftForm(restored);
      setSelectedCollateral(revision.collateral || selectedCollateral);
      setSavedRevision(revision);
      setSavedDraft({
        draftId: result.draft.id,
        revisionId: revision.id,
        revisionNumber: revision.revisionNumber,
        contentHash: revision.contentHash,
        status: result.draft.status,
      });
      setFieldErrors({});
      setRevisionConflict(null);
    } catch (err) {
      setError(err.message || 'The saved proposal could not be opened.');
    } finally {
      setDraftBusy(false);
    }
  }

  async function persistDraft() {
    const localErrors = validateDraftSave(draftValues);
    if (!question.trim()) localErrors.question = 'Question is required before saving.';
    if (Object.keys(localErrors).some(key => localErrors[key])) {
      setFieldErrors(localErrors);
      setError('Fix the highlighted fields before saving this proposal.');
      return null;
    }

    setDraftBusy(true);
    setError('');
    setFieldErrors({});
    try {
      const collateralOptions = {fixtureMode, allowlist: collateralAllowlist, catalog};
      const payload = {...draftPayload, category, question: question.trim()};
      let next;
      if (!savedDraft) {
        const created = await createDraft(payload, collateralOptions);
        next = {
          draftId: created.id,
          revisionId: created.revisionId,
          revisionNumber: created.revisionNumber || 1,
          contentHash: created.contentHash,
          status: 'draft',
        };
      } else {
        const updated = await updateDraft(savedDraft.draftId, payload, {
          ...collateralOptions,
          expectedRevisionId: savedDraft.revisionId,
        });
        next = {
          ...savedDraft,
          revisionId: updated.revisionId,
          revisionNumber: updated.revisionNumber,
          contentHash: updated.contentHash,
          status: updated.status || 'draft',
        };
      }
      const fresh = await getDraft(next.draftId).catch(() => null);
      if (fresh?.draft?.status) next.status = fresh.draft.status;
      rememberDraftId(next.draftId);
      setSelectedDraftId(String(next.draftId));
      setSavedDraft(next);
      setRevisionConflict(null);
      setSavedRevision({...next, question: question.trim(), category, collateral: selectedCollateral});
      await loadDrafts();
      return next;
    } catch (err) {
      if (err.status === 409 && err.body?.code === 'revision_conflict') {
        setRevisionConflict({
          currentRevisionId: err.body.currentRevisionId,
          currentRevisionNumber: err.body.currentRevisionNumber,
        });
      }
      setFieldErrors(draftFieldErrors(err));
      setError(err.message || 'The proposal could not be saved.');
      return null;
    } finally {
      setDraftBusy(false);
    }
  }

  async function submitForReview() {
    const timingErrors = validateDraftTiming({
      tradingClose: draftPayload.tradingClose,
      observationTime: draftPayload.observationTime,
      resolutionDeadline: draftPayload.resolutionDeadline,
    });
    if (Object.keys(timingErrors).length) {
      setFieldErrors(timingErrors);
      setError('Fix the highlighted UTC timing rules before submitting for review.');
      return;
    }
    const next = await persistDraft();
    if (!next) return;
    setDraftBusy(true);
    try {
      await submitDraft(next.draftId);
      const fresh = await getDraft(next.draftId);
      setSavedDraft(previous => ({...previous, status: fresh.draft.status}));
      if (fresh.revisions?.[0]) setSavedRevision(fresh.revisions[0]);
      setError('');
      setFieldErrors({});
      await loadDrafts();
    } catch (err) {
      setFieldErrors(draftFieldErrors(err));
      setError(err.message || 'The proposal could not be submitted for review.');
    } finally {
      setDraftBusy(false);
    }
  }

  async function withdrawProposal() {
    if (!savedDraft) return;
    setDraftBusy(true);
    setError('');
    try {
      await withdrawDraft(savedDraft.draftId);
      const fresh = await getDraft(savedDraft.draftId);
      setSavedDraft(previous => ({...previous, status: fresh.draft.status}));
      setSavedRevision(fresh.revisions?.[0] || savedRevision);
      await loadDrafts();
    } catch (err) {
      setError(err.message || 'The proposal could not be withdrawn.');
    } finally {
      setDraftBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    setError('');
    setUploadFailed(false);
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
        imageFile,
      }, (err) => {
        setError(err.message || 'Creation transaction failed');
        setUploadFailed(err.code === 'ARTWORK_UPLOAD');
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
      <section className="form-note" aria-label="Saved proposals" style={{padding: '10px 12px', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', marginBottom: '12px'}}>
        <div style={{display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap'}}>
          <strong style={{fontSize: '12px', color: '#f2f4f6'}}>Saved proposals</strong>
          <select
            aria-label="Saved proposals"
            value={selectedDraftId}
            onChange={event => setSelectedDraftId(event.target.value)}
            style={{flex: 1, minWidth: '12rem'}}
          >
            <option value="">Select a saved proposal…</option>
            {drafts.map(draft => (
              <option key={draft.id} value={draft.id}>
                #{draft.id} · {draft.status} · {draft.question || 'Untitled'}
              </option>
            ))}
          </select>
          <button type="button" className="button button-secondary" disabled={draftBusy || !selectedDraftId} onClick={() => openSavedDraft(selectedDraftId)}>Open</button>
          <button type="button" className="button button-quiet" disabled={draftBusy} onClick={loadDrafts}>Refresh</button>
        </div>
        {draftsNotice && <p className="form-note" role="status" style={{margin: '6px 0 0'}}>{draftsNotice}</p>}
        {savedDraft && <p className="form-note" role="status" style={{margin: '6px 0 0'}}>
          Editing proposal #{savedDraft.draftId} · revision #{savedDraft.revisionNumber} · status <strong>{savedDraft.status}</strong>
        </p>}
      </section>
      <form ref={formRef} className="dialog-form" onSubmit={submit}>
        <div className="form-row">
          <label>Market type
            <select value={kind} onChange={event => setKind(event.target.value)}>
              <option value="event">Event</option>
              <option value="price">Price</option>
            </select>
          </label>
          <label>Category
            <select name="category" value={category} onChange={event => setCategory(event.target.value)}>
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
              Proposal collateral (draft review only)
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
              <input name="question" value={question} onChange={e => {setQuestion(e.target.value); setFieldErrors(previous => ({...previous, question: undefined}));}} required maxLength="512" aria-invalid={Boolean(fieldErrors.question)} aria-describedby={fieldErrors.question ? 'question-error' : undefined} placeholder="Use a precise, verifiable yes/no question" style={{flex: 1}} />
              <button type="button" className="button button-secondary" disabled={aiLoading || busy || !resolvedCollateral.available} onClick={() => handleAiAssist()} style={{whiteSpace: 'nowrap'}}>
                {aiLoading ? 'Analyzing…' : 'Improve with AI'}
              </button>
            </div>
            <FieldError name="question" errors={fieldErrors} />
          </label>
          {revisionConflict && <div className="form-note" role="alert" style={{padding: '8px', background: 'rgba(255,255,255,0.05)', borderRadius: '4px', margin: '8px 0'}}>
            <p><PhosphorIcon name="info" size={14} /> This draft was changed in another tab or window (now revision {revisionConflict.currentRevisionNumber}). Your text is still here; nothing was overwritten.</p>
            <button type="button" className="button button-secondary" disabled={aiLoading || busy} onClick={() => handleAiAssist(revisionConflict.currentRevisionId)}>Save my version as a new revision</button>
          </div>}
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
        <label>Trading close (UTC)
          <input name="closes" type="datetime-local" required value={closes} onChange={event => {setCloses(event.target.value); setFieldErrors(previous => ({...previous, tradingClose: undefined}));}} aria-invalid={Boolean(fieldErrors.tradingClose)} aria-describedby={fieldErrors.tradingClose ? 'tradingClose-error' : undefined} />
          <FieldError name="tradingClose" errors={fieldErrors} />
        </label>
        <label>Market artwork <span className="field-optional">{kind === 'event' ? 'Required for event markets' : 'Optional · price markets show the token mark'}</span><input name="imageFile" type="file" accept="image/jpeg,image/png,image/webp" required={kind === 'event'} /></label>
        <p className="form-note">Artwork uploads are pinned by the backend; an off-chain Freighter sign-in may be requested. Only the image CID is stored on-chain.</p>
        <label>Resolution details / Description <span className="field-optional">Optional</span>
          <textarea name="description" rows="3" value={draftForm.description || ''} onChange={event => updateDraftField('description', event.target.value)} placeholder="Explain the resolution source, criteria, and evidence rules..." style={{width: '100%', resize: 'vertical'}} />
        </label>

        <fieldset style={{border: '1px solid rgba(255,255,255,0.12)', borderRadius: '8px', padding: '12px', display: 'grid', gap: '10px'}}>
          <legend style={{fontSize: '12px', color: '#9aa7b1', padding: '0 6px'}}>Review rules (saved with the proposal)</legend>
          <label>YES resolution rule
            <textarea name="yesRule" rows="2" value={draftForm.yesRule || ''} onChange={event => updateDraftField('yesRule', event.target.value)} aria-invalid={Boolean(fieldErrors.yesRule)} aria-describedby={fieldErrors.yesRule ? 'yesRule-error' : undefined} placeholder="State exactly what must happen for YES." style={{width: '100%', resize: 'vertical'}} />
            <FieldError name="yesRule" errors={fieldErrors} />
          </label>
          <label>NO resolution rule
            <textarea name="noRule" rows="2" value={draftForm.noRule || ''} onChange={event => updateDraftField('noRule', event.target.value)} aria-invalid={Boolean(fieldErrors.noRule)} aria-describedby={fieldErrors.noRule ? 'noRule-error' : undefined} placeholder="State exactly what must happen for NO (must differ from YES)." style={{width: '100%', resize: 'vertical'}} />
            <FieldError name="noRule" errors={fieldErrors} />
          </label>
          <div className="form-row">
            <label>Observation time (UTC) <span className="field-optional">Optional</span>
              <input name="observationTime" type="datetime-local" value={draftForm.observationTime || ''} onChange={event => updateDraftField('observationTime', event.target.value)} aria-invalid={Boolean(fieldErrors.observationTime)} aria-describedby={fieldErrors.observationTime ? 'observationTime-error' : undefined} />
              <FieldError name="observationTime" errors={fieldErrors} />
            </label>
            <label>Resolution deadline (UTC)
              <input name="resolutionDeadline" type="datetime-local" value={draftForm.resolutionDeadline || ''} onChange={event => updateDraftField('resolutionDeadline', event.target.value)} aria-invalid={Boolean(fieldErrors.resolutionDeadline)} aria-describedby={fieldErrors.resolutionDeadline ? 'resolutionDeadline-error' : undefined} />
              <FieldError name="resolutionDeadline" errors={fieldErrors} />
            </label>
          </div>
          <label>Sources <span className="field-optional">One URL or citation per line · required before submission</span>
            <textarea name="sources" rows="3" value={draftForm.sources || ''} onChange={event => updateDraftField('sources', event.target.value)} aria-invalid={Boolean(fieldErrors.sources)} aria-describedby={fieldErrors.sources ? 'sources-error' : undefined} placeholder={'https://source-one.example\nhttps://source-two.example'} style={{width: '100%', resize: 'vertical'}} />
            <FieldError name="sources" errors={fieldErrors} />
          </label>
          <label>Unavailable-data policy
            <textarea name="unavailableDataRule" rows="2" value={draftForm.unavailableDataRule || ''} onChange={event => updateDraftField('unavailableDataRule', event.target.value)} aria-invalid={Boolean(fieldErrors.unavailableDataRule)} aria-describedby={fieldErrors.unavailableDataRule ? 'unavailableDataRule-error' : undefined} placeholder="Explain how the market resolves if required data is unavailable." style={{width: '100%', resize: 'vertical'}} />
            <FieldError name="unavailableDataRule" errors={fieldErrors} />
          </label>
          <div className="form-row">
            <label>Equality rule <span className="field-optional">Optional</span>
              <input name="equalityRule" value={draftForm.equalityRule || ''} onChange={event => updateDraftField('equalityRule', event.target.value)} />
            </label>
            <label>Fallback rule <span className="field-optional">Optional</span>
              <input name="fallbackRule" value={draftForm.fallbackRule || ''} onChange={event => updateDraftField('fallbackRule', event.target.value)} />
            </label>
          </div>
        </fieldset>

        <DraftReviewSummary
          status={savedDraft?.status}
          revisionNumber={savedDraft?.revisionNumber}
          form={{...draftValues, tradingClose: parseUtcInput(closes), observationTime: parseUtcInput(draftForm.observationTime), resolutionDeadline: parseUtcInput(draftForm.resolutionDeadline)}}
          availability={draftAvailability}
        />
        <CollateralReviewSummary
          revision={activeRevisionForSummary}
          fixtureMode={fixtureMode}
          allowlist={collateralAllowlist}
          catalog={catalog}
        />
        <p className="form-note">Price markets use the first post-close observation from three sources. Event markets resolve according to stated evidence providers.</p>
        {previewMode && <p className="form-note">Read-only market preview.</p>}
        {!previewMode && <p className={escrow?.error ? 'form-error' : 'form-note'} aria-label="Market escrow">
          {escrow?.error || (escrow
            ? <>Stakes in this market are escrowed in <strong>{escrow.label}</strong> (contract {escrow.contractId}), set by the deployed market contract. The proposal collateral above is saved with drafts only.</>
            : 'Reading the escrow asset from the market contract…')}
        </p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {uploadFailed && <button type="button" className="button button-secondary" disabled={busy} onClick={() => formRef.current.requestSubmit()}>Retry upload</button>}
        <div className="dialog-actions" style={{display: 'flex', flexWrap: 'wrap', gap: '8px'}}>
          <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="button button-secondary" disabled={draftBusy || busy || previewMode || !draftAvailability.canSave} onClick={persistDraft}>
            {draftBusy ? 'Saving…' : savedDraft ? 'Save revision' : 'Save draft'}
          </button>
          <button type="button" className="button button-primary" disabled={draftBusy || busy || previewMode || !draftAvailability.canSubmit} onClick={submitForReview}>
            {savedDraft?.status === 'changes_requested' ? 'Save & resubmit' : 'Submit for review'}
          </button>
          {draftAvailability.canWithdraw && (
            <button type="button" className="button button-quiet" disabled={draftBusy || busy || previewMode} onClick={withdrawProposal}>Withdraw proposal</button>
          )}
        </div>
        {!draftAvailability.canSubmit && draftAvailability.reason && <p className="form-note" role="status">{draftAvailability.reason}</p>}
        <p className="form-note">Reviewed submissions are saved off-chain first. &ldquo;Create on testnet&rdquo; remains the separate direct on-chain action.</p>
        <div className="dialog-actions"><button className="button button-primary" disabled={busy || previewMode || !escrow?.label}>{previewMode ? 'Preview only' : busy ? 'Submitting…' : 'Create on testnet'}</button></div>
      </form>
    </section>
  </div>;
}
