import {createHash} from 'node:crypto';
import {StrKey} from '@stellar/stellar-sdk';

export const RULES_SCHEMA = 'revmarket.rules.v1';

const CANONICAL_FIELDS = [
  'schema',
  'network',
  'question',
  'category',
  'tradingClose',
  'observationTime',
  'resolutionDeadline',
  'yesRule',
  'noRule',
  'equalityRule',
  'sources',
  'fallbackRule',
  'unavailableDataRule',
  'collateral',
  'feeBps',
  'resolver',
  'policyVersion',
  'implementationVersion',
];

const EXCLUDED_ENVELOPE_FIELDS = new Set([
  'metadata',
  'metadataJson',
  'metadata_json',
  'id',
  'draftId',
  'draft_id',
  'revisionId',
  'revision_id',
  'revisionNumber',
  'revision_number',
  'reviewNotes',
  'reason',
  'signature',
  'signatures',
  'origin',
  'status',
  'createdAt',
  'created_at',
  'updatedAt',
  'updated_at',
  'ownerWallet',
  'owner_wallet',
  'contentHash',
  'content_hash',
  'approvedParamsHash',
  'approved_params_hash',
  'expiry',
]);

function hasLoneSurrogate(value) {
  if (typeof value.isWellFormed === 'function') {
    return !value.isWellFormed();
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertWellFormedString(value, fieldName, {minLength = 1, maxLength = 2048} = {}) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  if (hasLoneSurrogate(value)) {
    throw new Error(`${fieldName} contains malformed Unicode (unpaired surrogate)`);
  }
  if (value.trim().length < minLength) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${fieldName} exceeds maximum length of ${maxLength} characters`);
  }
  return value;
}

function assertNullableString(value, fieldName, {maxLength = 2048} = {}) {
  if (value === null) return null;
  if (value === undefined) {
    throw new Error(`${fieldName} must be explicitly null when inapplicable`);
  }
  return assertWellFormedString(value, fieldName, {minLength: 1, maxLength});
}

function assertSafeUnixSeconds(value, fieldName) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Object.is(value, -0) || value <= 0) {
    throw new Error(`${fieldName} must be a positive safe integer UTC Unix timestamp`);
  }
  return value;
}

function validateHttpsUrl(urlValue, fieldName) {
  const s = assertWellFormedString(urlValue, fieldName, {minLength: 8, maxLength: 512});
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error(`${fieldName} must use https://`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${fieldName} must not embed credentials`);
  }
  return s;
}

function normalizeSourceItem(item, index) {
  const label = `sources[${index}]`;
  if (typeof item === 'string') {
    return validateHttpsUrl(item, label);
  }
  if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) {
    throw new Error(`${label} must be an HTTPS URL string or plain source object`);
  }
  const keys = Object.keys(item);
  if (!keys.includes('url')) {
    throw new Error(`${label}.url is required for source objects`);
  }
  const normalized = {};
  for (const key of keys) {
    assertWellFormedString(key, `${label} key`, {minLength: 1, maxLength: 64});
    const val = item[key];
    if (key === 'url') {
      normalized.url = validateHttpsUrl(val, `${label}.url`);
    } else if (val === null || typeof val === 'boolean') {
      normalized[key] = val;
    } else if (typeof val === 'number') {
      if (!Number.isSafeInteger(val)) {
        throw new Error(`${label}.${key} must be a safe integer`);
      }
      normalized[key] = Object.is(val, -0) ? 0 : val;
    } else if (typeof val === 'string') {
      normalized[key] = assertWellFormedString(val, `${label}.${key}`, {minLength: 1, maxLength: 512});
    } else {
      throw new Error(`${label}.${key} has unsupported type`);
    }
  }
  return normalized;
}

function canonicalizeString(str) {
  if (hasLoneSurrogate(str)) {
    throw new Error('Cannot canonicalize string with unpaired UTF-16 surrogate');
  }
  let out = '"';
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code === 0x08) out += '\\b';
    else if (code === 0x09) out += '\\t';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0d) out += '\\r';
    else if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += '\\\\';
    else if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += str[i];
  }
  out += '"';
  return out;
}

/**
 * Serialize any JSON-compatible value according to RFC 8785 (JCS).
 * Rejects non-safe integers, non-finite numbers, undefined, functions, and lone surrogates.
 */
export function canonicalizeJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error('RFC 8785 rules encoder requires finite safe integers');
    }
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value === 'string') {
    return canonicalizeString(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => canonicalizeJson(item)).join(',') + ']';
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const sortedKeys = Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const members = [];
    for (const k of sortedKeys) {
      if (value[k] === undefined) {
        throw new Error(`Undefined value not permitted in canonical JSON at key ${k}`);
      }
      members.push(canonicalizeString(k) + ':' + canonicalizeJson(value[k]));
    }
    return '{' + members.join(',') + '}';
  }
  throw new Error('Unsupported value type for canonical JSON');
}

/**
 * Validate and normalize a revmarket.rules.v1 rules payload.
 * Excludes display metadata, local IDs, review notes, and signatures.
 */
export function normalizeRulesV1(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) {
    throw new Error('Rules payload must be a plain object');
  }

  for (const key of Object.keys(input)) {
    if (!CANONICAL_FIELDS.includes(key) && !EXCLUDED_ENVELOPE_FIELDS.has(key)) {
      throw new Error(`Unexpected field in rules payload: ${key}`);
    }
  }

  const schema = input.schema === undefined ? RULES_SCHEMA : input.schema;
  if (schema !== RULES_SCHEMA) {
    throw new Error(`Unsupported rules schema: expected ${RULES_SCHEMA}`);
  }

  const network = assertWellFormedString(input.network, 'network', {minLength: 1, maxLength: 128});
  const question = assertWellFormedString(input.question, 'question', {minLength: 1, maxLength: 512});
  const category = assertWellFormedString(input.category, 'category', {minLength: 1, maxLength: 128});

  const tradingClose = assertSafeUnixSeconds(input.tradingClose, 'tradingClose');
  const observationTime =
    input.observationTime === null
      ? null
      : input.observationTime === undefined
        ? (() => {
            throw new Error('observationTime must be a safe integer timestamp or explicit null');
          })()
        : assertSafeUnixSeconds(input.observationTime, 'observationTime');

  const resolutionDeadline = assertSafeUnixSeconds(input.resolutionDeadline, 'resolutionDeadline');

  if (observationTime !== null && observationTime < tradingClose) {
    throw new Error('observationTime must be greater than or equal to tradingClose');
  }
  if (resolutionDeadline <= tradingClose) {
    throw new Error('resolutionDeadline must be strictly after tradingClose');
  }
  if (observationTime !== null && resolutionDeadline < observationTime) {
    throw new Error('resolutionDeadline must be greater than or equal to observationTime');
  }

  const yesRule = assertWellFormedString(input.yesRule, 'yesRule', {minLength: 1, maxLength: 2048});
  const noRule = assertWellFormedString(input.noRule, 'noRule', {minLength: 1, maxLength: 2048});
  const equalityRule = assertNullableString(input.equalityRule, 'equalityRule', {maxLength: 2048});

  if (!Array.isArray(input.sources) || input.sources.length === 0 || input.sources.length > 10) {
    throw new Error('sources must be a non-empty array of 1 to 10 ordered sources');
  }
  const sources = input.sources.map((item, idx) => normalizeSourceItem(item, idx));

  const fallbackRule = assertNullableString(input.fallbackRule, 'fallbackRule', {maxLength: 2048});
  const unavailableDataRule = assertWellFormedString(input.unavailableDataRule, 'unavailableDataRule', {
    minLength: 1,
    maxLength: 2048,
  });

  const collateral = assertWellFormedString(input.collateral, 'collateral', {minLength: 1, maxLength: 128});
  if (collateral !== 'native' && !StrKey.isValidContract(collateral)) {
    throw new Error('collateral must be "native" or a valid Stellar contract address (C...)');
  }

  if (
    typeof input.feeBps !== 'number' ||
    !Number.isSafeInteger(input.feeBps) ||
    Object.is(input.feeBps, -0) ||
    input.feeBps < 0 ||
    input.feeBps > 1000
  ) {
    throw new Error('feeBps must be a safe integer between 0 and 1000');
  }
  const feeBps = input.feeBps;

  const resolver = assertWellFormedString(input.resolver, 'resolver', {minLength: 1, maxLength: 128});
  if (!StrKey.isValidEd25519PublicKey(resolver) && !StrKey.isValidContract(resolver)) {
    throw new Error('resolver must be a valid Stellar public key (G...) or contract address (C...)');
  }

  const policyVersion = assertWellFormedString(input.policyVersion, 'policyVersion', {minLength: 1, maxLength: 128});
  const implementationVersion = assertWellFormedString(input.implementationVersion, 'implementationVersion', {
    minLength: 1,
    maxLength: 128,
  });

  return {
    schema: RULES_SCHEMA,
    network,
    question,
    category,
    tradingClose,
    observationTime,
    resolutionDeadline,
    yesRule,
    noRule,
    equalityRule,
    sources,
    fallbackRule,
    unavailableDataRule,
    collateral,
    feeBps,
    resolver,
    policyVersion,
    implementationVersion,
  };
}

/**
 * Encode a validated revmarket.rules.v1 object into canonical UTF-8 bytes and SHA-256 hex digest.
 */
export function encodeRulesV1(input) {
  const payload = normalizeRulesV1(input);
  const json = canonicalizeJson(payload);
  const bytes = Buffer.from(json, 'utf8');
  const digest = createHash('sha256').update(bytes).digest('hex');
  return {payload, json, bytes, digest};
}

/**
 * Compute the lowercase hex SHA-256 digest of the canonical revmarket.rules.v1 UTF-8 bytes.
 */
export function hashRulesV1(input) {
  return encodeRulesV1(input).digest;
}

export {hashRulesV1 as rulesDigest};
