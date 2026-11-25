// Browser-compatible verification of a locally selected settlement evidence file.
//
// The worker writes v1 evidence as JSON.stringify(evidence) and records sha256 of those
// exact bytes on chain (Market.evidence). This module hashes the original file bytes with
// WebCrypto and then checks that the v1 fields bind to the selected market. It never
// uploads or fetches anything: the bytes stay in the browser.
export const MAX_EVIDENCE_BYTES = 1024 * 1024; // Same limit as service/evidence-export.mjs.

const HEX64 = /^[0-9a-f]{64}$/;
const ZERO = /^0{64}$/;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const PRICE_DECISION = /^-?\d+$/;
const V1_KEYS = ['closesAt', 'contractId', 'decision', 'marketId', 'observations', 'question', 'version'];
const EVENT_DECISION_KEYS = ['confidence', 'outcome'];

const isPlainObject = value =>
  value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const sameKeys = (value, keys) => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, i) => key === keys[i]);
};

/** Normalize contract bytes (Uint8Array / number[] / hex string) to lowercase hex. */
export function bytesToHex(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const hex = value.trim().toLowerCase();
    return HEX64.test(hex) ? hex : null;
  }
  let bytes;
  if (value instanceof Uint8Array) bytes = value;
  else if (Array.isArray(value) && value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) bytes = Uint8Array.from(value);
  else return null;
  if (bytes.byteLength !== 32) return null;
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Classify the market's recorded evidence commitment before any file is selected. */
export function digestOfMarket(market) {
  const hex = bytesToHex(market?.evidence);
  if (!hex) return {state: 'missing', hex: null};
  if (ZERO.test(hex)) return {state: 'zero', hex};
  return {state: 'available', hex};
}

async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto SHA-256 is unavailable');
  const input = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const digest = await subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** Parse and validate the v1 shape without rewriting or re-serializing the bytes. */
function validateV1(bytes) {
  let evidence;
  try {
    evidence = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch {
    return {status: 'malformed'};
  }
  const reject = reason => ({status: 'not-v1', reason});
  if (!isPlainObject(evidence)) return reject('top-level must be a JSON object');
  if (!sameKeys(evidence, V1_KEYS)) return reject(`top-level keys must be exactly ${V1_KEYS.join(', ')}`);
  const {version, contractId, marketId, question, closesAt, observations, decision} = evidence;
  if (version !== 1) return reject('version must be 1');
  if (typeof contractId !== 'string' || !CONTRACT_ID.test(contractId)) return reject('contractId must be a Stellar contract address');
  if (!Number.isInteger(marketId) || marketId < 0 || marketId > 2 ** 32 - 1) return reject('marketId must be an unsigned 32-bit integer');
  if (typeof question !== 'string' || question === '') return reject('question must be a non-empty string');
  if (!Number.isSafeInteger(closesAt) || closesAt <= 0) return reject('closesAt must be a positive integer');
  if (!Array.isArray(observations) || observations.length === 0 || !observations.every(isPlainObject)) return reject('observations must be a non-empty array of objects');
  const priceDecision = typeof decision === 'string' && PRICE_DECISION.test(decision);
  const eventDecision = isPlainObject(decision) && sameKeys(decision, EVENT_DECISION_KEYS)
    && Number.isInteger(decision.outcome) && Number.isInteger(decision.confidence);
  if (!priceDecision && !eventDecision) return reject('decision must be a decimal string or an object with integer outcome and confidence');
  return {status: 'valid', evidence};
}

/**
 * Verify a selected file against a market's recorded commitment.
 *
 * @returns {Promise<{status: string, [key: string]: unknown}>} one of
 *   missing-digest | zero-digest | empty | too-large | unsupported |
 *   integrity | malformed | not-v1 | binding | ok
 */
export async function verifyEvidenceBytes({bytes, market, contractId, maxBytes = MAX_EVIDENCE_BYTES} = {}) {
  const digest = digestOfMarket(market);
  if (digest.state === 'missing') return {status: 'missing-digest'};
  if (digest.state === 'zero') return {status: 'zero-digest'};

  const view = toBytes(bytes);
  if (!view) return {status: 'empty'};
  if (view.byteLength === 0) return {status: 'empty'};
  if (view.byteLength > maxBytes) return {status: 'too-large'};

  let actual;
  try {
    actual = await sha256Hex(view);
  } catch {
    return {status: 'unsupported'};
  }
  if (actual !== digest.hex) return {status: 'integrity', expected: digest.hex, actual};

  const parsed = validateV1(view);
  if (parsed.status !== 'valid') return parsed;
  const evidence = parsed.evidence;

  const checks = [
    ['contractId', evidence.contractId, typeof contractId === 'string' && contractId !== '' ? contractId : undefined],
    ['marketId', evidence.marketId, Number.isFinite(Number(market?.id)) ? Number(market.id) : undefined],
    ['question', evidence.question, typeof market?.question === 'string' ? market.question : undefined],
    ['closesAt', evidence.closesAt, market?.closes_at == null ? undefined : Number(market.closes_at)],
  ];
  for (const [field, actualValue, expected] of checks) {
    if (expected === undefined) continue;
    if (actualValue !== expected) return {status: 'binding', field, expected, actual: actualValue};
  }
  return {status: 'ok', digest: digest.hex, bytes: view.byteLength};
}
