// Read-only export of settlement evidence by its recorded digest.
// The digest commits to the exact bytes written by the worker (sha256 of JSON.stringify(evidence)),
// so the file is copied byte for byte and never re-serialized. Nothing is written until every check passes.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

export const MAX_EVIDENCE_BYTES = 1024 * 1024; // Same limit as the in-browser verifier (docs/issues/F03-evidence-verifier.md).
const DIGEST = /^[0-9a-f]{64}$/;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;
const PRICE_DECISION = /^-?\d+$/;
const V1_KEYS = ['closesAt', 'contractId', 'decision', 'marketId', 'observations', 'question', 'version'];
const EVENT_DECISION_KEYS = ['confidence', 'outcome'];

export class EvidenceExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EvidenceExportError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new EvidenceExportError(code, message); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const isInside = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};
const isPlainObject = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const sameKeys = (value, keys) => {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, i) => key === keys[i]);
};
const removeQuietly = async file => { try { await unlink(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } };

async function resolveDirectory(path, label, notFound, notDirectory) {
  if (typeof path !== 'string' || path === '') fail('INVALID_ARGUMENT', `${label} directory must be a non-empty path`);
  let real;
  try { real = await realpath(path); }
  catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') fail(notFound, `${label} directory does not exist: ${path}`); throw e; }
  if (!(await stat(real)).isDirectory()) fail(notDirectory, `${label} path is not a directory: ${path}`);
  return real;
}

async function readCandidate(realRoot, digest, maxBytes) {
  const candidate = join(realRoot, `${digest}.json`);
  let info;
  try { info = await lstat(candidate, {bigint: true}); }
  catch (e) { if (e.code === 'ENOENT') fail('EVIDENCE_NOT_FOUND', `No evidence file for digest ${digest} in the evidence root`); throw e; }
  if (info.isSymbolicLink()) fail('SYMLINK_REJECTED', `Evidence file for digest ${digest} is a symbolic link or junction; only regular files are exported`);
  if (!info.isFile()) fail('NOT_A_FILE', `Evidence path for digest ${digest} is not a regular file`);
  if (!isInside(realRoot, await realpath(candidate))) fail('OUTSIDE_ROOT', `Evidence file for digest ${digest} resolves outside the evidence root`);
  if (info.size > BigInt(maxBytes)) fail('TOO_LARGE', `Evidence file is ${info.size} bytes; the limit is ${maxBytes} bytes`);
  if (info.size === 0n) fail('EMPTY', `Evidence file for digest ${digest} is empty`);

  // Read from one handle and confirm it is the same file that was checked above.
  let handle;
  try { handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (e) {
    if (e.code === 'ELOOP') fail('SYMLINK_REJECTED', `Evidence file for digest ${digest} became a symbolic link`);
    if (e.code === 'ENOENT') fail('EVIDENCE_NOT_FOUND', `No evidence file for digest ${digest} in the evidence root`);
    throw e;
  }
  try {
    const opened = await handle.stat({bigint: true});
    if (!opened.isFile() || opened.size !== info.size || opened.ino !== info.ino || opened.dev !== info.dev) {
      fail('CHANGED_DURING_READ', `Evidence file for digest ${digest} changed while it was being opened`);
    }
    const bytes = Buffer.alloc(Number(info.size));
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function validateV1(bytes) {
  let evidence;
  try { evidence = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
  // The parser message can quote file content, so it is not included.
  catch { fail('MALFORMED_JSON', 'Evidence file is not valid UTF-8 JSON'); }
  const reject = reason => fail('NOT_V1_EVIDENCE', `Evidence file is not v1 settlement evidence: ${reason}`);
  if (!isPlainObject(evidence)) reject('top level must be a JSON object');
  if (!sameKeys(evidence, V1_KEYS)) reject(`top-level keys must be exactly ${V1_KEYS.join(', ')}`);
  const {version, contractId, marketId, question, closesAt, observations, decision} = evidence;
  if (version !== 1) reject('version must be 1');
  if (typeof contractId !== 'string' || !CONTRACT_ID.test(contractId)) reject('contractId must be a Stellar contract address');
  if (!Number.isInteger(marketId) || marketId < 0 || marketId > 2 ** 32 - 1) reject('marketId must be an unsigned 32-bit integer');
  if (typeof question !== 'string' || question === '') reject('question must be a non-empty string');
  if (!Number.isSafeInteger(closesAt) || closesAt <= 0) reject('closesAt must be a positive integer');
  if (!Array.isArray(observations) || observations.length === 0 || !observations.every(isPlainObject)) reject('observations must be a non-empty array of objects');
  const priceDecision = typeof decision === 'string' && PRICE_DECISION.test(decision);
  const eventDecision = isPlainObject(decision) && sameKeys(decision, EVENT_DECISION_KEYS)
    && Number.isInteger(decision.outcome) && Number.isInteger(decision.confidence);
  if (!priceDecision && !eventDecision) reject('decision must be a decimal string or an object with integer outcome and confidence');
  return {contractId, marketId};
}

async function publish(realOut, digest, bytes) {
  const final = join(realOut, `${digest}.json`);
  const exists = () => fail('OUTPUT_EXISTS', `Refusing to overwrite existing file: ${final}`);
  if (await lstat(final).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) exists();

  const tmp = join(realOut, `.${digest}.${process.pid}.${randomUUID()}.tmp`);
  let linked = false, verified = false;
  try {
    const handle = await open(tmp, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try { await link(tmp, final); linked = true; }
    catch (e) {
      if (e.code === 'EEXIST') exists();
      fail('LINK_FAILED', `Could not create ${final} (${e.code ?? 'unknown error'}); the output directory must be writable and on a filesystem that supports hard links`);
    }
    const written = await readFile(final);
    if (!written.equals(bytes) || sha256(written) !== digest) fail('WRITE_VERIFY_FAILED', `Written file does not hash to ${digest}; it was removed`);
    verified = true;
    return final;
  } finally {
    // Best effort, each step independent: an unverified export goes first, then the temp file.
    // A cleanup error must not hide the original error.
    if (linked && !verified) await removeQuietly(final).catch(() => {});
    await removeQuietly(tmp).catch(() => {});
  }
}

export async function exportEvidence({root, digest, out, maxBytes = MAX_EVIDENCE_BYTES} = {}) {
  // 1. Validate the identifier before any filesystem access.
  if (typeof digest !== 'string' || !DIGEST.test(digest)) fail('INVALID_DIGEST', 'Digest must be exactly 64 lowercase hexadecimal characters');
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) fail('INVALID_ARGUMENT', 'maxBytes must be a positive integer');
  // 2. Resolve the configured evidence root (it may itself be a link).
  const realRoot = await resolveDirectory(root, 'Evidence root', 'ROOT_NOT_FOUND', 'ROOT_NOT_DIRECTORY');
  // 3-4. Confine, size-check and read the exact stored bytes, then hash them.
  const bytes = await readCandidate(realRoot, digest, maxBytes);
  const actual = sha256(bytes);
  if (actual !== digest) fail('DIGEST_MISMATCH', `Evidence bytes hash to ${actual}, expected ${digest}`);
  // 5. Validate the v1 shape without rewriting anything.
  const {contractId, marketId} = validateV1(bytes);
  // 6. Publish into an existing directory outside the root, never overwriting.
  const realOut = await resolveDirectory(out, 'Output', 'OUT_NOT_FOUND', 'OUT_NOT_DIRECTORY');
  if (isInside(realRoot, realOut)) fail('OUT_INSIDE_ROOT', 'Output directory must be outside the evidence root');
  const outFile = await publish(realOut, digest, bytes);
  return {digest, bytes: bytes.length, outFile, contractId, marketId};
}
