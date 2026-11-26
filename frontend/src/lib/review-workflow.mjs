// Pure helpers for the reviewer queue and exact-revision decision flow.
// The backend remains authoritative for role and state checks; these helpers
// keep the UI honest about what can be submitted and turn failures into guidance.

export function parseUtcSeconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const normalized = `${value}:00Z`;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const [, year, month, day, hour, minute] = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00Z$/.exec(normalized);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== 0
  ) {
    return null;
  }
  const seconds = Math.floor(parsed / 1000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

export function formatUtcSeconds(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return 'Not set';
  return `${new Date(seconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function decisionAvailability(session = {}, draft = {}) {
  const connected = Boolean(session?.wallet);
  const canViewQueue = Boolean(session?.canReviewQueue || session?.isActiveReviewer || session?.isSuperAdmin);
  const isActiveReviewer = Boolean(session?.isActiveReviewer);
  const isOwner = Boolean(session?.wallet && draft?.ownerWallet && session.wallet === draft.ownerWallet);
  const isSubmitted = draft?.status === 'submitted';
  let reason = '';

  if (!connected) reason = 'Sign in to the activity profile to load the review queue.';
  else if (!canViewQueue) reason = 'Your session does not have reviewer queue access.';
  else if (!isActiveReviewer) reason = 'Super-admin access can read the queue, but only active reviewers can submit decisions.';
  else if (isOwner) reason = 'You cannot review your own draft.';
  else if (!isSubmitted) reason = 'Only submitted drafts can be decided. Reload the queue to see current items.';

  return {
    connected,
    canViewQueue,
    canDecide: canViewQueue && isActiveReviewer && !isOwner && isSubmitted,
    reason,
  };
}

export function decisionErrorFeedback(error) {
  const status = error?.status;
  const message = String(error?.message || '');
  if (status === 401) {
    return 'Your session expired. Sign in to the activity profile again, then reload the review queue.';
  }
  if (status === 403) {
    if (/Active reviewer/i.test(message)) {
      return 'Your reviewer role is no longer active. Ask a super-admin to restore it before deciding.';
    }
    if (/own draft/i.test(message)) {
      return 'You cannot review your own draft.';
    }
    return 'Your current role cannot submit this decision.';
  }
  if (status === 409) {
    if (/newer revision/i.test(message)) {
      return 'This draft has a newer revision. Reload the queue and inspect the saved revision before deciding again.';
    }
    if (/Only submitted/i.test(message)) {
      return 'This draft was already decided or withdrawn. Reload the queue; no decision was recorded.';
    }
    return 'The draft changed before your decision. Reload the queue and try again.';
  }
  if (status === 400 && /expiry/i.test(message)) {
    return 'Approval expiry must be a future UTC time.';
  }
  return error?.body?.error || message || 'The decision could not be submitted.';
}

export function buildReviewPayload({decision, reason = '', expiryInput = '', expectedRevisionId} = {}, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(expectedRevisionId) || expectedRevisionId <= 0) {
    throw new Error('Open the saved revision before submitting a decision.');
  }
  if (!['changes_requested', 'rejected', 'approved'].includes(decision)) {
    throw new Error('Choose request changes, reject, or approve.');
  }
  const payload = {decision, reason: String(reason).trim(), expectedRevisionId};
  if (decision === 'approved') {
    const expiry = parseUtcSeconds(expiryInput);
    if (expiry === null || expiry <= nowSeconds) {
      throw new Error('Approval expiry must be a valid UTC time in the future.');
    }
    payload.expiry = expiry;
  }
  return payload;
}

export function latestDecision(reviews = []) {
  const review = Array.isArray(reviews) ? reviews[0] : null;
  if (!review) return null;
  return {
    decision: review.decision || '',
    reason: review.reason || '',
    revisionId: review.revisionId ?? null,
    reviewerWallet: review.reviewerWallet || '',
    expiry: review.expiry ?? null,
    expiryLabel: formatUtcSeconds(review.expiry),
    createdAt: review.createdAt ?? null,
  };
}

export function sourcesFromRevision(revision = {}) {
  let sources = [];
  try {
    const parsed = JSON.parse(revision.sourcesJson || revision.sources_json || '[]');
    if (Array.isArray(parsed)) sources = parsed.filter(source => typeof source === 'string');
  } catch {
    sources = [];
  }
  return sources;
}

export function revisionRuleSummary(revision = {}) {
  return {
    revisionId: revision.id ?? null,
    revisionNumber: revision.revisionNumber ?? null,
    question: revision.question || '',
    category: revision.category || '',
    yesRule: revision.yesRule || '',
    noRule: revision.noRule || '',
    equalityRule: revision.equalityRule || '',
    fallbackRule: revision.fallbackRule || '',
    unavailableDataRule: revision.unavailableDataRule || '',
    sources: sourcesFromRevision(revision),
    tradingClose: formatUtcSeconds(revision.tradingClose),
    observationTime: formatUtcSeconds(revision.observationTime),
    resolutionDeadline: formatUtcSeconds(revision.resolutionDeadline),
  };
}
