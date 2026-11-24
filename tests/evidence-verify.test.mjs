import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {
  MAX_EVIDENCE_BYTES,
  bytesToHex,
  digestOfMarket,
  verifyEvidenceBytes,
} from '../frontend/src/lib/evidence-verify.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE_DIGEST = '7a52df7e56ccf05cef40ec4f8e2958f779b24824855a82091731e7d7a4360051';
const FIXTURE_FILE = join(repoRoot, 'docs', 'smoke-evidence', `${FIXTURE_DIGEST}.json`);
const FIXTURE_MARKET = {
  id: 0,
  question: 'Integration fixture: deterministic YES (not a real-world event)',
  closes_at: 1793201196,
  outcome: 0,
  confidence: 9000,
  status: 2,
};
const FIXTURE_CONTRACT = 'CCRZ7JKPNKRLPJO5XWF5WBBDOIU3UXCNP3PDEQ3YHYV4CVDC6WTHZ323';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const bytesFromHex = hex => Uint8Array.from(Buffer.from(hex, 'hex'));
const fixtureBytes = () => readFile(FIXTURE_FILE);
const marketWith = (evidence, extra = {}) => ({...FIXTURE_MARKET, evidence, ...extra});
const verify = (bytes, market, contractId = FIXTURE_CONTRACT) => verifyEvidenceBytes({bytes, market, contractId});

test('digestOfMarket classifies missing, all-zero, invalid and available evidence', () => {
  assert.deepEqual(digestOfMarket({evidence: null}), {state: 'missing', hex: null});
  assert.deepEqual(digestOfMarket({}), {state: 'missing', hex: null});
  assert.deepEqual(digestOfMarket({evidence: new Uint8Array(32)}), {state: 'zero', hex: '0'.repeat(64)});
  assert.equal(digestOfMarket({evidence: new Uint8Array(31)}).state, 'missing');
  assert.equal(digestOfMarket({evidence: 'not-hex'}).state, 'missing');
  assert.deepEqual(
    digestOfMarket({evidence: bytesFromHex(FIXTURE_DIGEST)}),
    {state: 'available', hex: FIXTURE_DIGEST},
  );
  assert.equal(bytesToHex(Array(32).fill(0xff)), 'ff'.repeat(32));
  assert.equal(bytesToHex(FIXTURE_DIGEST.toUpperCase()), FIXTURE_DIGEST);
});

test('the saved smoke fixture verifies against its digest and market binding', async () => {
  const result = await verify(await fixtureBytes(), marketWith(bytesFromHex(FIXTURE_DIGEST)));
  assert.equal(result.status, 'ok');
  assert.equal(result.digest, FIXTURE_DIGEST);
  assert.equal(result.bytes, 713);
});

test('a single changed byte fails integrity and shows both hashes', async () => {
  const bytes = await fixtureBytes();
  bytes[100] ^= 0x01;
  const result = await verify(bytes, marketWith(bytesFromHex(FIXTURE_DIGEST)));
  assert.equal(result.status, 'integrity');
  assert.equal(result.expected, FIXTURE_DIGEST);
  assert.equal(result.actual, sha256(bytes));
});

test('whitespace or re-serialization fails integrity even though the JSON is equivalent', async () => {
  const bytes = Buffer.from(JSON.stringify(JSON.parse((await fixtureBytes()).toString('utf8')), null, 2));
  const result = await verify(bytes, marketWith(bytesFromHex(FIXTURE_DIGEST)));
  assert.equal(result.status, 'integrity');
});

test('a matching file still fails when the contract, market, question or close time does not bind', async () => {
  const bytes = await fixtureBytes();
  const market = marketWith(bytesFromHex(FIXTURE_DIGEST));

  assert.equal((await verify(bytes, market, 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).status, 'binding');
  assert.equal((await verify(bytes, market, 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')).field, 'contractId');
  assert.equal((await verify(bytes, {...market, id: 1})).field, 'marketId');
  assert.equal((await verify(bytes, {...market, question: 'A different question'})).field, 'question');
  assert.equal((await verify(bytes, {...market, closes_at: 1793201197})).field, 'closesAt');
});

test('an unsupported version fails after a matching digest', async () => {
  const body = JSON.parse((await fixtureBytes()).toString('utf8'));
  const bytes = Buffer.from(JSON.stringify({...body, version: 2}));
  const result = await verify(bytes, marketWith(bytesFromHex(sha256(bytes))));
  assert.equal(result.status, 'not-v1');
  assert.match(result.reason, /version/);
});

test('malformed JSON fails after a matching digest', async () => {
  const bytes = Buffer.from('not json: private-marker');
  const result = await verify(bytes, marketWith(bytesFromHex(sha256(bytes))));
  assert.equal(result.status, 'malformed');
  assert.ok(!JSON.stringify(result).includes('private-marker'));
});

test('empty and oversized files have dedicated states before hashing', async () => {
  const market = marketWith(bytesFromHex(FIXTURE_DIGEST));
  assert.equal((await verify(new Uint8Array(0), market)).status, 'empty');
  const oversized = Buffer.alloc(MAX_EVIDENCE_BYTES + 1, 0x20);
  assert.equal((await verify(oversized, market)).status, 'too-large');
});

test('missing and all-zero on-chain digests cannot verify any file', async () => {
  const bytes = await fixtureBytes();
  assert.equal((await verify(bytes, marketWith(null))).status, 'missing-digest');
  assert.equal((await verify(bytes, marketWith(new Uint8Array(32)))).status, 'zero-digest');
});
