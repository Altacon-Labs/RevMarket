import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exportEvidence, EvidenceExportError} from '../service/evidence-export.mjs';
import {processMarket} from '../service/runner.mjs';
import {digest as evidenceDigest} from '../service/policy.mjs';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE_DIGEST = '7a52df7e56ccf05cef40ec4f8e2958f779b24824855a82091731e7d7a4360051';
const FIXTURE_FILE = join(repoRoot, 'docs', 'smoke-evidence', `${FIXTURE_DIGEST}.json`);
// Independently known market values the fixture commits to (what a verifier reads from chain).
const FIXTURE_MARKET = {
  digest: FIXTURE_DIGEST,
  contractId: 'CCRZ7JKPNKRLPJO5XWF5WBBDOIU3UXCNP3PDEQ3YHYV4CVDC6WTHZ323',
  marketId: 0,
  question: 'Integration fixture: deterministic YES (not a real-world event)',
  closesAt: 1793201196,
};
const MIB = 1024 * 1024;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixtureBytes = () => readFile(FIXTURE_FILE); // raw Buffer, never decoded with platform line endings

async function tempDir(t, label) {
  const dir = await mkdtemp(join(tmpdir(), `revmarket-evidence-${label}-`));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}
async function setup(t) {
  return {root: await tempDir(t, 'root'), out: await tempDir(t, 'out')};
}
async function store(root, bytes, name = `${sha256(bytes)}.json`) {
  await writeFile(join(root, name), bytes);
  return name.slice(0, -'.json'.length);
}
async function expectCode(promise, code) {
  await assert.rejects(promise, e => {
    assert.ok(e instanceof EvidenceExportError, `expected EvidenceExportError, got ${e}`);
    assert.equal(e.code, code, e.message);
    return true;
  });
}
const listing = async dir => (await readdir(dir)).sort();
async function assertEmpty(dir) { assert.deepEqual(await listing(dir), []); }
async function linkOrSkip(t, target, path, type) {
  try { await symlink(target, path, type); return true; }
  catch (e) {
    if (e.code === 'EPERM' || e.code === 'EACCES') { t.skip('symlink creation not permitted on this host'); return false; }
    throw e;
  }
}

// Mirrors the checks specified for the #14 in-browser verifier (docs/issues/F03-evidence-verifier.md):
// size limit, SHA-256 over the original bytes, then v1 binding to contract/market/question/close time.
function verifyLikeF03(bytes, market) {
  if (bytes.length === 0) return 'empty';
  if (bytes.length > MIB) return 'too-large';
  if (sha256(bytes) !== market.digest) return 'integrity';
  let evidence;
  try { evidence = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch { return 'malformed'; }
  if (evidence?.version !== 1) return 'version';
  for (const field of ['contractId', 'marketId', 'question', 'closesAt']) if (evidence[field] !== market[field]) return `binding:${field}`;
  return 'ok';
}

// A worker-shaped run: processMarket from service/runner.mjs with the same save path as service/worker.mjs.
async function workerRun(root, kind) {
  const m = {status: 0, closes_at: 200n, deadline: 86600n, kind, question: 'Question'};
  const saved = [];
  const options = {
    id: 4, source: 'test', sign: () => {}, now: () => 205,
    client: {read: async () => ({...m}), write: async (s, k, method) => { m.status = method === 'request' ? 1 : 2; }},
    providers: {
      contractId: FIXTURE_MARKET.contractId,
      price: async () => [100n, 101n, 102n].map((p, i) => ({source: `p${i}`, price: (p * 100000000n).toString(), observedAt: 201})),
      event: async () => [0, 1].map(i => ({source: `h${i}`, marketId: 4, questionHash: evidenceDigest('Question'), outcome: 1, confidence: 9000, observedAt: 201, evidenceUrl: 'https://example.org'})),
    },
    saveEvidence: async (hash, body) => {
      await writeFile(join(root, `${hash}.json`), JSON.stringify(body), {flag: 'wx', mode: 0o600});
      saved.push({hash, body});
    },
  };
  assert.equal(await processMarket(options), 'settled');
  return saved[0];
}

test('AC1: smoke fixture exports byte-identical, hashes to the digest, and leaves no temp files', async t => {
  const {root, out} = await setup(t);
  const source = await fixtureBytes();
  await store(root, source, `${FIXTURE_DIGEST}.json`);
  const result = await exportEvidence({root, digest: FIXTURE_DIGEST, out});
  const outFile = join(await realpath(out), `${FIXTURE_DIGEST}.json`);
  assert.deepEqual(result, {digest: FIXTURE_DIGEST, bytes: source.length, outFile, contractId: FIXTURE_MARKET.contractId, marketId: 0});
  const exported = await readFile(outFile);
  assert.ok(exported.equals(source));
  assert.equal(sha256(exported), FIXTURE_DIGEST);
  assert.deepEqual(await listing(out), [`${FIXTURE_DIGEST}.json`]);
  assert.deepEqual(await listing(root), [`${FIXTURE_DIGEST}.json`]);
});

test('AC1: exported file passes the #14 verifier checks; a flipped byte or re-serialization fails them', async t => {
  const {root, out} = await setup(t);
  await store(root, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  const {outFile} = await exportEvidence({root, digest: FIXTURE_DIGEST, out});
  const exported = await readFile(outFile);
  assert.equal(verifyLikeF03(exported, FIXTURE_MARKET), 'ok');
  const flipped = Buffer.from(exported); flipped[20] ^= 0x01;
  assert.equal(verifyLikeF03(flipped, FIXTURE_MARKET), 'integrity');
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(exported.toString('utf8')), null, 2));
  assert.equal(verifyLikeF03(reserialized, FIXTURE_MARKET), 'integrity');
  assert.equal(verifyLikeF03(exported, {...FIXTURE_MARKET, marketId: 1}), 'binding:marketId');
});

for (const [label, kind, decision] of [
  ['Price (string decision)', ['Price', 'ETH', 100n], '10100000000'],
  ['Event (object decision)', ['Event'], {outcome: 1, confidence: 9000}],
]) {
  test(`AC1: end to end from the worker save path, ${label}`, async t => {
    const {root, out} = await setup(t);
    const {hash, body} = await workerRun(root, kind);
    assert.deepEqual(body.decision, decision);
    assert.equal(hash, evidenceDigest(body));
    const result = await exportEvidence({root, digest: hash, out});
    const exported = await readFile(result.outFile);
    assert.ok(exported.equals(await readFile(join(root, `${hash}.json`))));
    assert.equal(sha256(exported), hash);
    assert.equal(verifyLikeF03(exported, {digest: hash, contractId: FIXTURE_MARKET.contractId, marketId: 4, question: 'Question', closesAt: 200}), 'ok');
  });
}

test('AC2: invalid identifiers are rejected before any filesystem access and write nothing', async t => {
  const {root, out} = await setup(t);
  await store(root, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  const missingRoot = join(root, 'does-not-exist');
  const invalid = [
    FIXTURE_DIGEST.toUpperCase(),
    FIXTURE_DIGEST.slice(0, 63),
    `${FIXTURE_DIGEST}0`,
    `../${FIXTURE_DIGEST.slice(0, 61)}`,
    `${FIXTURE_DIGEST.slice(0, 31)}/${FIXTURE_DIGEST.slice(32)}`,
    `${FIXTURE_DIGEST.slice(0, 31)}\\${FIXTURE_DIGEST.slice(32)}`,
    `${FIXTURE_DIGEST.slice(0, 63)}\0`,
    '',
    123,
    null,
    undefined,
    Buffer.from(FIXTURE_DIGEST),
  ];
  for (const digest of invalid) {
    // A missing root would raise ROOT_NOT_FOUND if the filesystem were consulted first.
    await expectCode(exportEvidence({root: missingRoot, digest, out}), 'INVALID_DIGEST');
    // On case-insensitive filesystems an uppercase name would otherwise open the real file.
    await expectCode(exportEvidence({root, digest, out}), 'INVALID_DIGEST');
  }
  await assertEmpty(out);
});

test('AC2: a valid digest with no stored file fails with EVIDENCE_NOT_FOUND', async t => {
  const {root, out} = await setup(t);
  await expectCode(exportEvidence({root, digest: FIXTURE_DIGEST, out}), 'EVIDENCE_NOT_FOUND');
  await assertEmpty(out);
});

test('AC2: a flipped byte fails with DIGEST_MISMATCH and reports both hashes', async t => {
  const {root, out} = await setup(t);
  const bytes = await fixtureBytes(); bytes[100] ^= 0x01;
  await store(root, bytes, `${FIXTURE_DIGEST}.json`);
  await assert.rejects(exportEvidence({root, digest: FIXTURE_DIGEST, out}), e => {
    assert.equal(e.code, 'DIGEST_MISMATCH');
    assert.ok(e.message.includes(FIXTURE_DIGEST) && e.message.includes(sha256(bytes)));
    return true;
  });
  await assertEmpty(out);
});

test('AC2: malformed bytes fail with MALFORMED_JSON without echoing file content', async t => {
  const {root, out} = await setup(t);
  for (const bytes of [Buffer.from('not json: private-marker'), Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), Buffer.from('{"version":1')]) {
    const digest = await store(root, bytes);
    await assert.rejects(exportEvidence({root, digest, out}), e => {
      assert.equal(e.code, 'MALFORMED_JSON');
      assert.ok(!e.message.includes('private-marker'));
      return true;
    });
  }
  await assertEmpty(out);
});

test('AC2: valid JSON that is not v1 evidence fails with NOT_V1_EVIDENCE', async t => {
  const {root, out} = await setup(t);
  const base = JSON.parse((await fixtureBytes()).toString('utf8'));
  const cases = {
    'unrelated object': {hello: 'world'},
    'array': [base],
    'null': null,
    'extra secret key': {...base, secret: 'resolver-key'},
    'missing decision': (({decision, ...rest}) => rest)(base),
    'version 2': {...base, version: 2},
    'lowercase contract': {...base, contractId: base.contractId.toLowerCase()},
    'negative market': {...base, marketId: -1},
    'market over u32': {...base, marketId: 2 ** 32},
    'empty question': {...base, question: ''},
    'zero closesAt': {...base, closesAt: 0},
    'string closesAt': {...base, closesAt: '1793201196'},
    'empty observations': {...base, observations: []},
    'numeric decision': {...base, decision: 1.5},
    'decimal string decision': {...base, decision: '1.5'},
    'event decision missing confidence': {...base, decision: {outcome: 0}},
    'event decision extra key': {...base, decision: {outcome: 0, confidence: 9000, note: 'x'}},
  };
  for (const [label, value] of Object.entries(cases)) {
    const digest = await store(root, Buffer.from(JSON.stringify(value)));
    await assert.rejects(exportEvidence({root, digest, out}), e => {
      assert.equal(e.code, 'NOT_V1_EVIDENCE', `${label}: ${e.message}`);
      assert.ok(!e.message.includes('resolver-key'));
      return true;
    }, label);
  }
  await assertEmpty(out);
});

test('AC2: empty and oversized files fail with EMPTY and TOO_LARGE', async t => {
  const {root, out} = await setup(t);
  await expectCode(exportEvidence({root, digest: await store(root, Buffer.alloc(0)), out}), 'EMPTY');
  await expectCode(exportEvidence({root, digest: await store(root, Buffer.alloc(MIB + 1, 0x20)), out}), 'TOO_LARGE');
  await assertEmpty(out);
});

test('AC2: an existing output file is never overwritten', async t => {
  const {root, out} = await setup(t);
  await store(root, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  const existing = Buffer.from('operator copy, keep');
  await writeFile(join(out, `${FIXTURE_DIGEST}.json`), existing);
  await expectCode(exportEvidence({root, digest: FIXTURE_DIGEST, out}), 'OUTPUT_EXISTS');
  assert.ok((await readFile(join(out, `${FIXTURE_DIGEST}.json`))).equals(existing));
  assert.deepEqual(await listing(out), [`${FIXTURE_DIGEST}.json`]);
});

test('AC2: a missing output directory is not created', async t => {
  const {root, out} = await setup(t);
  await store(root, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  await expectCode(exportEvidence({root, digest: FIXTURE_DIGEST, out: join(out, 'typo')}), 'OUT_NOT_FOUND');
  await assertEmpty(out);
});

test('AC3: a file symlink to evidence outside the root is rejected', async t => {
  const {root, out} = await setup(t);
  const outside = await tempDir(t, 'outside');
  await store(outside, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  if (!(await linkOrSkip(t, join(outside, `${FIXTURE_DIGEST}.json`), join(root, `${FIXTURE_DIGEST}.json`), 'file'))) return;
  await expectCode(exportEvidence({root, digest: FIXTURE_DIGEST, out}), 'SYMLINK_REJECTED');
  await assertEmpty(out);
});

test('AC3: a junction or directory link named like evidence is rejected', async t => {
  const {root, out} = await setup(t);
  const outside = await tempDir(t, 'outside');
  await store(outside, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  if (!(await linkOrSkip(t, outside, join(root, `${FIXTURE_DIGEST}.json`), 'junction'))) return;
  await expectCode(exportEvidence({root, digest: FIXTURE_DIGEST, out}), 'SYMLINK_REJECTED');
  await assertEmpty(out);
});

test('AC3: a directory named like evidence is rejected as NOT_A_FILE', async t => {
  const {root, out} = await setup(t);
  await mkdir(join(root, `${FIXTURE_DIGEST}.json`));
  await expectCode(exportEvidence({root, digest: FIXTURE_DIGEST, out}), 'NOT_A_FILE');
  await assertEmpty(out);
});

test('AC3: output inside or equal to the evidence root is refused and the root is unchanged', async t => {
  const {root} = await setup(t);
  await store(root, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  await mkdir(join(root, 'nested'));
  const before = await listing(root);
  await expectCode(exportEvidence({root, digest: FIXTURE_DIGEST, out: root}), 'OUT_INSIDE_ROOT');
  await expectCode(exportEvidence({root, digest: FIXTURE_DIGEST, out: join(root, 'nested')}), 'OUT_INSIDE_ROOT');
  const elsewhere = await tempDir(t, 'link');
  if (await linkOrSkip(t, root, join(elsewhere, 'to-root'), 'junction')) {
    await expectCode(exportEvidence({root, digest: FIXTURE_DIGEST, out: join(elsewhere, 'to-root')}), 'OUT_INSIDE_ROOT');
  }
  assert.deepEqual(await listing(root), before);
  await assertEmpty(join(root, 'nested'));
});

test('AC3: a missing or non-directory root fails clearly', async t => {
  const {root, out} = await setup(t);
  await expectCode(exportEvidence({root: join(root, 'missing'), digest: FIXTURE_DIGEST, out}), 'ROOT_NOT_FOUND');
  await writeFile(join(root, 'file'), 'x');
  await expectCode(exportEvidence({root: join(root, 'file'), digest: FIXTURE_DIGEST, out}), 'ROOT_NOT_DIRECTORY');
  await expectCode(exportEvidence({root: '', digest: FIXTURE_DIGEST, out}), 'INVALID_ARGUMENT');
  await assertEmpty(out);
});

test('AC3: the evidence root may itself be a junction or symlink to a real directory', async t => {
  const {root, out} = await setup(t);
  await store(root, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  const linkParent = await tempDir(t, 'link');
  const linkedRoot = join(linkParent, 'evidence');
  if (!(await linkOrSkip(t, root, linkedRoot, 'junction'))) return;
  const {outFile} = await exportEvidence({root: linkedRoot, digest: FIXTURE_DIGEST, out});
  assert.ok((await readFile(outFile)).equals(await fixtureBytes()));
});

test('AC3: only the requested evidence file is exported from a populated root', async t => {
  const {root, out} = await setup(t);
  const source = await fixtureBytes();
  await store(root, source, `${FIXTURE_DIGEST}.json`);
  await workerRun(root, ['Price', 'ETH', 100n]);
  await workerRun(root, ['Event']);
  await writeFile(join(root, 'notes.txt'), 'operator notes');
  await writeFile(join(root, 'resolver.env'), 'RESOLVER_SECRET=placeholder');
  await exportEvidence({root, digest: FIXTURE_DIGEST, out});
  assert.deepEqual(await listing(out), [`${FIXTURE_DIGEST}.json`]);
  assert.ok((await readFile(join(out, `${FIXTURE_DIGEST}.json`))).equals(source));
});

function cli(args, env = {}) {
  const childEnv = {...process.env, ...env};
  if (env.EVIDENCE_DIR === undefined) delete childEnv.EVIDENCE_DIR;
  return spawnSync(process.execPath, ['scripts/export-evidence.mjs', ...args], {cwd: repoRoot, env: childEnv, encoding: 'utf8'});
}

test('CLI: exports with EVIDENCE_DIR, prints one JSON line, refuses a second export', async t => {
  const {root, out} = await setup(t);
  await store(root, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  const first = cli([FIXTURE_DIGEST, '--out', out], {EVIDENCE_DIR: root});
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const lines = first.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const summary = JSON.parse(lines[0]);
  assert.equal(summary.digest, FIXTURE_DIGEST);
  assert.equal(summary.marketId, 0);
  assert.equal(sha256(await readFile(summary.outFile)), FIXTURE_DIGEST);
  const second = cli([FIXTURE_DIGEST, '--out', out], {EVIDENCE_DIR: root});
  assert.equal(second.status, 1);
  assert.match(second.stderr, /^evidence:export failed \[OUTPUT_EXISTS\]: /);
});

test('CLI: invalid digest exits 1 with a clear code, no stack trace, and no output file', async t => {
  const {out} = await setup(t);
  const run = cli([FIXTURE_DIGEST.toUpperCase(), '--out', out]);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /\[INVALID_DIGEST\]/);
  assert.doesNotMatch(run.stderr, /\n\s+at /);
  await assertEmpty(out);
});

test('CLI: --root overrides EVIDENCE_DIR', async t => {
  const {root, out} = await setup(t);
  await store(root, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  const emptyRoot = await tempDir(t, 'empty');
  const run = cli([FIXTURE_DIGEST, '--out', out, '--root', emptyRoot], {EVIDENCE_DIR: root});
  assert.equal(run.status, 1);
  assert.match(run.stderr, /\[EVIDENCE_NOT_FOUND\]/);
  await assertEmpty(out);
  const ok = cli([FIXTURE_DIGEST, '--out', out, '--root', root], {EVIDENCE_DIR: emptyRoot});
  assert.equal(ok.status, 0, ok.stderr);
});

test('CLI: missing --out, extra arguments, repeated and unknown options are usage errors', async t => {
  const {root, out} = await setup(t);
  await store(root, await fixtureBytes(), `${FIXTURE_DIGEST}.json`);
  for (const args of [
    [FIXTURE_DIGEST],
    [FIXTURE_DIGEST, FIXTURE_DIGEST, '--out', out],
    [FIXTURE_DIGEST, '--out', out, '--force'],
    [FIXTURE_DIGEST, '--out', out, '--root', root, '--root', root],
  ]) {
    const run = cli(args, {EVIDENCE_DIR: root});
    assert.equal(run.status, 1, args.join(' '));
    assert.match(run.stderr, /\[USAGE\]/);
  }
  await assertEmpty(out);
});
