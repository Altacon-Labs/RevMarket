import {useCallback, useEffect, useState} from 'react';
import {Link, useNavigate, useParams} from 'react-router-dom';
import PhosphorIcon from '../icons/PhosphorIcon.jsx';
import {
  createPublicationIntent,
  getPublicationIntent,
  listPublicationIntents,
} from '../lib/backend.mjs';
import {
  FACTORY_CAPABILITY_STATUS,
  buildIntentLink,
  normalizeIntentView,
  openOrReloadPublicationIntent,
} from '../lib/publication-intent.mjs';

export function PublicationIntentView({
  view,
  reused = false,
  rejectionMessage = null,
  busy = false,
  onReload,
}) {
  const isPending = view.status === 'pending';
  const statusBorder = isPending ? '#3698f4' : '#f05b65';
  const statusColor = isPending ? '#83c8ff' : '#ff9399';

  return (
    <div className="settings-page publication-intent-page" data-intent-status={view.status}>
      <div className="page-heading">
        <div>
          <p className="eyebrow">CREATOR PUBLICATION CONFIRMATION · OFF-CHAIN INTENT</p>
          <h1>Publication intent #{view.id}</h1>
        </div>
        <div style={{display: 'flex', gap: '8px', flexWrap: 'wrap'}}>
          {onReload && (
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={onReload}
            >
              <PhosphorIcon name="refresh" size={16} />
              <span>{busy ? 'Reloading…' : 'Reload intent status'}</span>
            </button>
          )}
          <Link className="button button-quiet" to={view.revisionLink}>
            Back to revision #{view.revisionNumber}
          </Link>
        </div>
      </div>

      {/* Status & Off-Chain Boundary Banner */}
      <section
        className="settings-section"
        aria-label="Publication intent status"
        style={{
          borderColor: statusBorder,
        }}
      >
        <div className="settings-section-heading">
          <div>
            <p className="eyebrow">INTENT STATE</p>
            <h2>{view.statusLabel}</h2>
            <p>{view.statusDetail}</p>
          </div>
          <span
            className="status-pill"
            data-testid="intent-status-pill"
            style={{borderColor: statusBorder, color: statusColor}}
          >
            {view.status.toUpperCase()}
          </span>
        </div>

        {reused && isPending && (
          <p className="form-note" role="status">
            Reusing existing pending publication intent #{view.id} for draft #{view.draftId} revision #{view.revisionNumber}.
          </p>
        )}

        {rejectionMessage && !isPending && (
          <p className="form-error" role="alert">
            {rejectionMessage}
          </p>
        )}

        <div className="settings-detail-row">
          <span>Authority</span>
          <strong>{view.authority}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Confirmed on-chain market</span>
          <strong>{view.confirmedMarket ? 'Yes' : 'No (confirmedMarket = false)'}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Minted market ID</span>
          <strong>{view.marketId ?? 'None — not minted on-chain'}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Confirmed transaction</span>
          <strong>{view.txHash ?? 'None — no on-chain transaction submitted'}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Live trading list</span>
          <strong>Not listed in live markets</strong>
        </div>
      </section>

      {/* Explicit Factory Capability & Legacy Flow Boundary */}
      <section className="settings-section" aria-label="Factory capability and deployment boundary">
        <div className="settings-section-heading">
          <div>
            <p className="eyebrow">DEPLOYMENT BOUNDARY · NEXT STEP</p>
            <h2>Reviewed factory deployment unavailable</h2>
            <p>{FACTORY_CAPABILITY_STATUS.nextStep}</p>
          </div>
          <span className="status-pill" style={{borderColor: '#f5a623', color: '#ffd180'}}>
            OFF-CHAIN ONLY
          </span>
        </div>
        <div className="settings-detail-row">
          <span>Factory contract ({FACTORY_CAPABILITY_STATUS.factoryContract})</span>
          <strong>{FACTORY_CAPABILITY_STATUS.currentCapability}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Missing capability</span>
          <strong>{FACTORY_CAPABILITY_STATUS.missingCapability}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Legacy create flow boundary</span>
          <strong>{FACTORY_CAPABILITY_STATUS.legacyBoundary}</strong>
        </div>
      </section>

      {/* Approval, Wallets, Network, Expiry & Digests */}
      <section className="settings-section" aria-label="Approval metadata and digests">
        <div className="settings-section-heading">
          <div>
            <p className="eyebrow">APPROVAL &amp; CRYPTOGRAPHIC BINDING</p>
            <h2>Wallets, network, expiry and digests</h2>
            <p>All fields below are pinned to the approved draft revision and verified by the publication API.</p>
          </div>
        </div>
        <div className="settings-detail-row">
          <span>Approved revision</span>
          <strong>
            <Link to={view.revisionLink}>
              Draft #{view.draftId} · Revision #{view.revisionNumber} (id {view.revisionId})
            </Link>
          </strong>
        </div>
        <div className="settings-detail-row">
          <span>Creator wallet</span>
          <code style={{wordBreak: 'break-all'}}>{view.creatorWallet}</code>
        </div>
        <div className="settings-detail-row">
          <span>Approving reviewer</span>
          <code style={{wordBreak: 'break-all'}}>{view.reviewerWallet}</code>
        </div>
        <div className="settings-detail-row">
          <span>Target network</span>
          <strong>{view.targetNetwork} ({view.networkPassphrase})</strong>
        </div>
        <div className="settings-detail-row">
          <span>Approval expiry</span>
          <strong>{view.approvalExpiryFormatted}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Rules digest (canonical API digest)</span>
          <code data-testid="rules-digest" style={{wordBreak: 'break-all'}}>{view.rulesDigest}</code>
        </div>
        <div className="settings-detail-row">
          <span>Parameters hash</span>
          <code data-testid="params-hash" style={{wordBreak: 'break-all'}}>{view.paramsHash}</code>
        </div>
      </section>

      {/* Exact Approved Terms */}
      <section className="settings-section" aria-label="Exact approved market terms">
        <div className="settings-section-heading">
          <div>
            <p className="eyebrow">EXACT APPROVED TERMS</p>
            <h2>{view.terms.question}</h2>
            <p>Schema: {view.terms.schema}</p>
          </div>
        </div>
        <div className="settings-detail-row">
          <span>Category</span>
          <strong>{view.terms.category || 'General'}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Trading close</span>
          <strong>{view.terms.tradingCloseFormatted}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Observation time</span>
          <strong>{view.terms.observationTimeFormatted}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Resolution deadline</span>
          <strong>{view.terms.resolutionDeadlineFormatted}</strong>
        </div>
        <div className="settings-detail-row">
          <span>YES resolution rule</span>
          <strong>{view.terms.yesRule}</strong>
        </div>
        <div className="settings-detail-row">
          <span>NO resolution rule</span>
          <strong>{view.terms.noRule}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Equality rule</span>
          <strong>{view.terms.equalityRule}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Fallback rule</span>
          <strong>{view.terms.fallbackRule}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Unavailable data rule</span>
          <strong>{view.terms.unavailableDataRule}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Data sources</span>
          <strong>{view.terms.sources.length ? view.terms.sources.join(', ') : 'None'}</strong>
        </div>
        <div className="settings-detail-row">
          <span>Collateral</span>
          <code style={{wordBreak: 'break-all'}}>{view.terms.collateral}</code>
        </div>
        <div className="settings-detail-row">
          <span>Fee (bps)</span>
          <strong>{view.terms.feeBps} bps</strong>
        </div>
        <div className="settings-detail-row">
          <span>Resolver</span>
          <code style={{wordBreak: 'break-all'}}>{view.terms.resolver || 'Not specified'}</code>
        </div>
        <div className="settings-detail-row">
          <span>Policy / Implementation version</span>
          <strong>{view.terms.policyVersion || '—'} / {view.terms.implementationVersion || '—'}</strong>
        </div>
      </section>
    </div>
  );
}

export default function PublicationIntentPage({
  now,
  createPublicationIntentFn = createPublicationIntent,
  getPublicationIntentFn = getPublicationIntent,
  listPublicationIntentsFn = listPublicationIntents,
}) {
  const {draftId, revisionId, intentId} = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [state, setState] = useState(null);

  const loadIntent = useCallback(async ({isReload = false} = {}) => {
    setLoading(true);
    setError('');
    try {
      const result = await openOrReloadPublicationIntent({
        draftId,
        intentId: isReload && state?.intent?.id ? state.intent.id : intentId,
        revisionId,
        createPublicationIntentFn,
        getPublicationIntentFn,
        listPublicationIntentsFn,
        nowSeconds: now,
      });
      setState(result);
      // Persist canonical intent URL so browser reload re-fetches via getPublicationIntent(intentId)
      if (!intentId && result.intent?.id) {
        navigate(buildIntentLink(result.intent.id), {replace: true});
      }
    } catch (err) {
      setError(err.message || 'Unable to load publication intent.');
    } finally {
      setLoading(false);
    }
  }, [draftId, intentId, revisionId, createPublicationIntentFn, getPublicationIntentFn, listPublicationIntentsFn, navigate, now, state?.intent?.id]);

  useEffect(() => {
    loadIntent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftId, intentId, revisionId]);

  if (loading && !state) {
    return (
      <div className="settings-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">CREATOR PUBLICATION CONFIRMATION</p>
            <h1>Loading publication intent…</h1>
          </div>
        </div>
      </div>
    );
  }

  if (error && !state) {
    return (
      <div className="settings-page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">CREATOR PUBLICATION CONFIRMATION</p>
            <h1>Publication intent unavailable</h1>
          </div>
          <Link className="button button-quiet" to="/markets">Back to markets</Link>
        </div>
        <section className="settings-section">
          <p className="form-error" role="alert">{error}</p>
          <p className="form-note">{FACTORY_CAPABILITY_STATUS.legacyBoundary}</p>
        </section>
      </div>
    );
  }

  const liveView = state?.intent ? normalizeIntentView(state.intent, {nowSeconds: now}) : null;
  if (!liveView) return null;

  return (
    <PublicationIntentView
      view={liveView}
      reused={state.reused}
      rejectionMessage={state.rejectionMessage}
      busy={loading}
      onReload={() => loadIntent({isReload: true})}
    />
  );
}
