// Pure helpers for the reviewed-draft creator workflow.
// Backend validation remains authoritative; these helpers provide immediate,
// field-specific feedback and keep UTC handling consistent in the client.

const SECONDS_PER_DAY = 86400;

export function toUtcInput(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) return '';
  return new Date(seconds * 1000).toISOString().slice(0, 16);
}

export function parseUtcInput(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)
    ? `${value}:00Z`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value}Z`
      : null;
  if (!normalized) return null;
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?Z$/.exec(normalized);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second = '00'] = parts;
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() + 1 !== Number(month) ||
    date.getUTCDate() !== Number(day) ||
    date.getUTCHours() !== Number(hour) ||
    date.getUTCMinutes() !== Number(minute) ||
    date.getUTCSeconds() !== Number(second)
  ) {
    return null;
  }
  const seconds = Math.floor(parsed / 1000);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : null;
}

export function defaultCloseInput(nowSeconds = Math.floor(Date.now() / 1000)) {
  return toUtcInput(nowSeconds + 7 * SECONDS_PER_DAY);
}

// Saving an incomplete proposal only needs parseable UTC inputs. Full review
// requirements are checked by the backend when the saved revision is submitted.
export function validateDraftSave(form = {}) {
  const errors = {};
  if (parseUtcInput(form.tradingClose) === null) {
    errors.tradingClose = 'Enter a valid UTC trading close.';
  }
  if (form.observationTime && parseUtcInput(form.observationTime) === null) {
    errors.observationTime = 'Enter a valid UTC observation time.';
  }
  if (form.resolutionDeadline && parseUtcInput(form.resolutionDeadline) === null) {
    errors.resolutionDeadline = 'Enter a valid UTC resolution deadline.';
  }
  return errors;
}

export function validateDraftTiming(fields, nowSeconds = Math.floor(Date.now() / 1000)) {
  const errors = {};
  const close = fields.tradingClose;
  const observation = fields.observationTime;
  const deadline = fields.resolutionDeadline;

  if (close === null || !Number.isSafeInteger(close) || close <= nowSeconds) {
    errors.tradingClose = 'Trading close must be a valid UTC time in the future.';
  }
  if (observation !== null && (!Number.isSafeInteger(observation) || observation <= 0)) {
    errors.observationTime = 'Observation time must be a valid UTC timestamp.';
  } else if (observation !== null && close !== null && observation < close) {
    errors.observationTime = 'Observation time must be at or after trading close.';
  }
  if (deadline === null || !Number.isSafeInteger(deadline) || deadline <= 0) {
    errors.resolutionDeadline = 'Resolution deadline is required.';
  } else if (close !== null && deadline <= close) {
    errors.resolutionDeadline = 'Resolution deadline must be strictly after trading close.';
  } else if (observation !== null && deadline < observation) {
    errors.resolutionDeadline = 'Resolution deadline must be at or after observation time.';
  }
  return errors;
}

export function parseSources(value) {
  if (typeof value !== 'string') return [];
  return value
    .split('\n')
    .map(source => source.trim())
    .filter(Boolean);
}

export function sourcesToTextarea(sources) {
  return Array.isArray(sources)
    ? sources.filter(source => typeof source === 'string').join('\n')
    : '';
}

export function draftFieldErrors(error) {
  const fields = error?.body?.fields;
  return fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
}

export function getDraftActionAvailability(status) {
  switch (status) {
    case 'submitted':
      return {
        canSave: false,
        canSubmit: false,
        canWithdraw: true,
        reason: 'This proposal is submitted. Withdraw it before editing or resubmitting.',
      };
    case 'approved':
      return {
        canSave: false,
        canSubmit: false,
        canWithdraw: true,
        reason: 'This proposal is approved. Withdraw it before making a new revision.',
      };
    case 'rejected':
      return {
        canSave: false,
        canSubmit: false,
        canWithdraw: false,
        reason: 'This proposal was rejected and cannot be resubmitted.',
      };
    case 'changes_requested':
      return {
        canSave: true,
        canSubmit: true,
        canWithdraw: false,
        reason: 'Edit the requested changes, save, then resubmit for review.',
      };
    case 'draft':
    case undefined:
    case null:
    default:
      return {canSave: true, canSubmit: true, canWithdraw: false, reason: ''};
  }
}

export function formFromDraftRevision(revision = {}) {
  // GET /api/drafts/:id returns camelCase columns; older fixtures/tests may use
  // the snake_case database names. Accept both so a reloaded draft is identical.
  const value = (...names) => names.map(name => revision?.[name]).find(candidate => candidate !== undefined);
  let sources = [];
  try {
    const parsed = JSON.parse(value('sourcesJson', 'sources_json') || '[]');
    if (Array.isArray(parsed)) sources = parsed.filter(source => typeof source === 'string');
  } catch {
    sources = [];
  }
  let metadata = {};
  try {
    const parsed = JSON.parse(value('metadataJson', 'metadata_json') || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
  } catch {
    metadata = {};
  }
  return {
    question: value('question') || '',
    category: value('category') || 'General',
    tradingClose: toUtcInput(value('tradingClose', 'trading_close')),
    observationTime: toUtcInput(value('observationTime', 'observation_time')),
    resolutionDeadline: toUtcInput(value('resolutionDeadline', 'resolution_deadline')),
    yesRule: value('yesRule', 'yes_rule') || '',
    noRule: value('noRule', 'no_rule') || '',
    equalityRule: value('equalityRule', 'equality_rule') || '',
    sources: sourcesToTextarea(sources),
    fallbackRule: value('fallbackRule', 'fallback_rule') || '',
    unavailableDataRule: value('unavailableDataRule', 'unavailable_data_rule') || '',
    resolver: value('resolver') || '',
    policyVersion: value('policyVersion', 'policy_version') || '',
    implementationVersion: value('implementationVersion', 'implementation_version') || '',
    description: typeof metadata.description === 'string' ? metadata.description : '',
  };
}

export function buildDraftPayload(form, {collateral, nowSeconds = Math.floor(Date.now() / 1000)} = {}) {
  const tradingClose = parseUtcInput(form.tradingClose);
  const observationTime = parseUtcInput(form.observationTime);
  const resolutionDeadline = parseUtcInput(form.resolutionDeadline);
  const payload = {
    question: (form.question || '').trim(),
    category: (form.category || 'General').trim() || 'General',
    tradingClose,
    observationTime,
    resolutionDeadline,
    yesRule: (form.yesRule || '').trim(),
    noRule: (form.noRule || '').trim(),
    equalityRule: (form.equalityRule || '').trim(),
    sources: parseSources(form.sources),
    fallbackRule: (form.fallbackRule || '').trim(),
    unavailableDataRule: (form.unavailableDataRule || '').trim(),
    collateral,
    resolver: (form.resolver || '').trim(),
    policyVersion: (form.policyVersion || '').trim(),
    implementationVersion: (form.implementationVersion || '').trim(),
    metadata: {description: (form.description || '').trim()},
    origin: 'manual',
  };
  const timingErrors = validateDraftTiming(
    {tradingClose, observationTime, resolutionDeadline},
    nowSeconds,
  );
  return {payload, timingErrors};
}
