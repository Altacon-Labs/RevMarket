export const FACTORY_CAPABILITY_STATUS = Object.freeze({
  mode: 'off_chain_intent_only',
  factoryContract: 'RevMarketFactory',
  currentCapability: 'Registers operator-approved market WASM implementation hashes (approve_version / get_version) only.',
  missingCapability: 'Reviewed-create deployment entrypoint is not yet deployed on RevMarketFactory.',
  legacyBoundary: 'The legacy "Create a market" modal deploys directly to the legacy contract without reviewer approval. Approved revisions stay in this off-chain publication intent flow and never silently fall back to legacy create.',
  nextStep: 'Keep this pending publication intent pinned to the approved revision. On-chain deployment will unlock once RevMarketFactory adds a reviewed-create capability that verifies the approved rules digest and reviewer authorization.',
});

export const INVALIDATION_REASON_LABELS = Object.freeze({
  draft_revised: 'Invalidated: draft was edited after approval. Submit the new revision for fresh review.',
  draft_withdrawn: 'Invalidated: draft was withdrawn by the creator.',
  reviewer_revoked: 'Invalidated: the approving reviewer was revoked.',
  approval_expired: 'Expired: the reviewer approval window has elapsed.',
});

export function formatUtcTimestamp(unixSeconds) {
  if (unixSeconds === null || unixSeconds === undefined || !Number.isFinite(Number(unixSeconds))) {
    return 'Not specified';
  }
  const num = Number(unixSeconds);
  return `${new Date(num * 1000).toISOString().replace('.000Z', 'Z')} (${num})`;
}

export function buildRevisionLink(draftId, revisionId) {
  return `/drafts/${draftId}/revisions/${revisionId}`;
}

export function buildIntentLink(intentId) {
  return `/publication-intents/${intentId}`;
}

export function compareRulesDigest(displayedDigest, canonicalDigest) {
  const normalizedDisplayed = typeof displayedDigest === 'string' ? displayedDigest.trim().toLowerCase() : '';
  const normalizedCanonical = typeof canonicalDigest === 'string' ? canonicalDigest.trim().toLowerCase() : '';
  const matches = Boolean(normalizedDisplayed && normalizedCanonical && normalizedDisplayed === normalizedCanonical);
  return {
    matches,
    displayedDigest: normalizedDisplayed,
    canonicalDigest: normalizedCanonical,
  };
}

export function normalizeIntentView(intent, {nowSeconds = Math.floor(Date.now() / 1000)} = {}) {
  if (!intent || typeof intent !== 'object') {
    throw new Error('Publication intent record is required');
  }
  const params = intent.parameters || {};
  const isExpiredByClock =
    intent.status === 'pending' &&
    typeof intent.approvalExpiry === 'number' &&
    intent.approvalExpiry <= nowSeconds;

  const effectiveStatus = isExpiredByClock ? 'expired' : intent.status;
  const effectiveReason = isExpiredByClock
    ? 'approval_expired'
    : (intent.invalidatedReason || null);

  let statusLabel = 'Pending off-chain intent';
  let statusTone = 'pending';
  if (effectiveStatus === 'invalidated') {
    statusLabel = 'Invalidated';
    statusTone = 'invalidated';
  } else if (effectiveStatus === 'expired') {
    statusLabel = 'Expired';
    statusTone = 'expired';
  }

  const statusDetail = effectiveStatus === 'pending'
    ? 'Off-chain publication intent recorded. Not a confirmed on-chain market and not listed in live trading.'
    : (INVALIDATION_REASON_LABELS[effectiveReason] || `Intent is ${effectiveStatus}.`);

  return {
    id: intent.id,
    draftId: intent.draftId,
    revisionId: intent.revisionId,
    revisionNumber: intent.revisionNumber,
    reviewDecisionId: intent.reviewDecisionId,
    revisionLink: buildRevisionLink(intent.draftId, intent.revisionId),
    intentLink: buildIntentLink(intent.id),
    creatorWallet: intent.creatorWallet,
    reviewerWallet: intent.reviewerWallet,
    targetNetwork: intent.targetNetwork,
    networkPassphrase: intent.networkPassphrase,
    approvalExpiry: intent.approvalExpiry,
    approvalExpiryFormatted: formatUtcTimestamp(intent.approvalExpiry),
    rulesDigest: intent.rulesDigest,
    paramsHash: intent.paramsHash,
    status: effectiveStatus,
    statusLabel,
    statusTone,
    statusDetail,
    invalidatedReason: effectiveReason,
    invalidatedAt: intent.invalidatedAt || null,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    authority: intent.authority || 'off_chain_publication_intent',
    confirmedMarket: false,
    deployed: false,
    marketId: null,
    contractAddress: null,
    txHash: null,
    inLiveTradingList: false,
    factoryStatus: FACTORY_CAPABILITY_STATUS,
    terms: {
      schema: params.schema || 'revmarket.publication-intent.v1',
      question: params.question || '',
      category: params.category || '',
      tradingClose: params.tradingClose ?? null,
      tradingCloseFormatted: formatUtcTimestamp(params.tradingClose),
      observationTime: params.observationTime ?? null,
      observationTimeFormatted: formatUtcTimestamp(params.observationTime),
      resolutionDeadline: params.resolutionDeadline ?? null,
      resolutionDeadlineFormatted: formatUtcTimestamp(params.resolutionDeadline),
      yesRule: params.yesRule || '',
      noRule: params.noRule || '',
      equalityRule: params.equalityRule || 'Not specified',
      sources: Array.isArray(params.sources) ? params.sources : [],
      fallbackRule: params.fallbackRule || 'Not specified',
      unavailableDataRule: params.unavailableDataRule || '',
      collateral: params.collateral || 'native',
      feeBps: params.feeBps ?? 0,
      resolver: params.resolver || '',
      policyVersion: params.policyVersion || '',
      implementationVersion: params.implementationVersion || '',
    },
  };
}

/**
 * Loads or creates/reuses a publication intent for a route.
 * - When `intentId` is given (e.g. reload on /publication-intents/:intentId), reloads via `getPublicationIntent`.
 * - When `draftId` is given (e.g. /drafts/:draftId/publish), calls `createPublicationIntent` to create or reuse
 *   the pending intent. If the API rejects with 409 because the draft was edited, withdrawn, reviewer-revoked,
 *   or expired, falls back to `listPublicationIntents(draftId)` so the invalidated/expired intent is still shown.
 */
export async function openOrReloadPublicationIntent({
  draftId,
  intentId,
  revisionId,
  createPublicationIntentFn,
  getPublicationIntentFn,
  listPublicationIntentsFn,
  nowSeconds,
}) {
  if (intentId !== undefined && intentId !== null && intentId !== '') {
    const numericIntentId = Number(intentId);
    if (!Number.isSafeInteger(numericIntentId) || numericIntentId <= 0) {
      throw new Error('Invalid publication intent ID.');
    }
    const res = await getPublicationIntentFn(numericIntentId);
    return {
      intent: res.intent,
      reused: true,
      view: normalizeIntentView(res.intent, {nowSeconds}),
      rejectionMessage: null,
    };
  }

  const numericDraftId = Number(draftId);
  if (!Number.isSafeInteger(numericDraftId) || numericDraftId <= 0) {
    throw new Error('Invalid draft ID.');
  }

  const payload = {};
  if (revisionId !== undefined && revisionId !== null && revisionId !== '') {
    const numericRevisionId = Number(revisionId);
    if (Number.isSafeInteger(numericRevisionId) && numericRevisionId > 0) {
      payload.revisionId = numericRevisionId;
    }
  }

  try {
    const res = await createPublicationIntentFn(numericDraftId, payload);
    return {
      intent: res.intent,
      reused: Boolean(res.reused),
      view: normalizeIntentView(res.intent, {nowSeconds}),
      rejectionMessage: null,
    };
  } catch (err) {
    if (err && err.status === 409 && typeof listPublicationIntentsFn === 'function') {
      const listed = await listPublicationIntentsFn(numericDraftId);
      const intents = Array.isArray(listed?.intents) ? listed.intents : [];
      const matching = payload.revisionId
        ? intents.find(item => item.revisionId === payload.revisionId) || intents[0]
        : intents[0];
      if (matching) {
        return {
          intent: matching,
          reused: true,
          view: normalizeIntentView(matching, {nowSeconds}),
          rejectionMessage: err.message || 'Publication intent is no longer eligible.',
        };
      }
    }
    throw err;
  }
}
