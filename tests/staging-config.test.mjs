import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Keypair} from '@stellar/stellar-sdk';
import {BackendConfigError, createGracefulShutdown, resolveBackendConfig} from '../backend/config.mjs';
import {createBackup, defaultProbe, promoteRestore, verifyRestore} from '../backend/backup.mjs';
import {openStore} from '../backend/store.mjs';

const serverScript = fileURLToPath(new URL('../backend/server.mjs', import.meta.url));
const STAGING_ORIGIN = 'https://staging.revmarket.example';

function freePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const {port} = s.address();
      s.close(() => res(port));
    });
  });
}

function cleanEnv(overrides = {}) {
  const base = {};
  for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'NODE_OPTIONS']) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return {...base, ...overrides};
}

function spawnFailingServer(envOverrides) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', serverScript], {
      env: cleanEnv(envOverrides),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', rej);
    child.on('exit', code => res({code, stdout, stderr}));
  });
}

async function startServerProcess(t, envOverrides, port) {
  const child = spawn(process.execPath, ['--experimental-sqlite', serverScript], {
    env: cleanEnv(envOverrides),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(r => child.once('exit', (code, signal) => r({code, signal})));
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
  });
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`backend exited early (${child.exitCode}): ${stderr}`);
    }
    if ((await defaultProbe(port, {timeoutMs: 400})).up) {
      return {
        child,
        exited,
        stopGracefully: async () => {
          if (child.connected) child.send('shutdown');
          else child.kill('SIGTERM');
          const res = await exited;
          assert.equal((await defaultProbe(port, {timeoutMs: 400})).up, false);
          return res;
        },
      };
    }
    await new Promise(r => setTimeout(r, 15));
  }
  child.kill();
  throw new Error(`backend did not become ready within 45s: ${stderr}`);
}

async function callApi(port, path, {method = 'GET', body, cookie, origin = STAGING_ORIGIN} = {}) {
  const headers = {Connection: 'close'};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: r.status,
    body: await r.json(),
    cookie: r.headers.get('set-cookie')?.split(';')[0] || null,
  };
}

test('AC1: missing required staging or partial AI config fails with variable names only and never leaks secrets', () => {
  const secretJwt = 'pinata-super-secret-token-value-111';
  const secretAiKey = 'sk-live-secret-ai-key-value-222';

  // Staging mode requires APP_ORIGIN, BACKEND_DB, BACKEND_PORT
  assert.throws(
    () => resolveBackendConfig({BACKEND_ENV: 'staging', PINATA_JWT: secretJwt}),
    err => {
      assert.ok(err instanceof BackendConfigError);
      assert.equal(err.code, 'CONFIG_MISSING');
      assert.deepEqual(err.missing, ['APP_ORIGIN', 'BACKEND_DB', 'BACKEND_PORT']);
      assert.equal(err.message, 'Missing required configuration: APP_ORIGIN, BACKEND_DB, BACKEND_PORT');
      assert.ok(!err.message.includes(secretJwt));
      return true;
    },
  );

  // Partial AI configuration fails with missing AI variable names only
  assert.throws(
    () => resolveBackendConfig({
      BACKEND_ENV: 'staging',
      APP_ORIGIN: STAGING_ORIGIN,
      BACKEND_DB: '/var/lib/revmarket/revmarket.sqlite',
      BACKEND_PORT: '3001',
      AI_API_KEY: secretAiKey,
    }),
    err => {
      assert.ok(err instanceof BackendConfigError);
      assert.equal(err.code, 'CONFIG_MISSING');
      assert.deepEqual(err.missing, ['AI_ENDPOINT', 'AI_MODEL']);
      assert.equal(err.message, 'Missing required configuration: AI_ENDPOINT, AI_MODEL');
      assert.ok(!err.message.includes(secretAiKey));
      return true;
    },
  );

  // AI_ENABLED=true without AI credentials fails naming all three AI variables
  assert.throws(
    () => resolveBackendConfig({AI_ENABLED: 'true'}),
    err => {
      assert.ok(err instanceof BackendConfigError);
      assert.equal(err.code, 'CONFIG_MISSING');
      assert.deepEqual(err.missing, ['AI_ENDPOINT', 'AI_API_KEY', 'AI_MODEL']);
      assert.equal(err.message, 'Missing required configuration: AI_ENDPOINT, AI_API_KEY, AI_MODEL');
      return true;
    },
  );

  // Explicitly blank variables in local mode fail with variable names only
  assert.throws(
    () => resolveBackendConfig({APP_ORIGIN: '   ', BACKEND_PORT: ''}),
    err => {
      assert.ok(err instanceof BackendConfigError);
      assert.equal(err.code, 'CONFIG_MISSING');
      assert.deepEqual(err.missing, ['APP_ORIGIN', 'BACKEND_PORT']);
      assert.equal(err.message, 'Missing required configuration: APP_ORIGIN, BACKEND_PORT');
      return true;
    },
  );
});

test('AC1 & AC3: invalid config, production/mainnet mode, and leaked worker RESOLVER_SECRET fail with variable names only', () => {
  const leakedResolverSecret = 'SCZ7_SECRET_RESOLVER_SEED_VALUE_DO_NOT_ECHO';

  // Reject RESOLVER_SECRET in backend API environment (API/worker separation)
  assert.throws(
    () => resolveBackendConfig({RESOLVER_SECRET: leakedResolverSecret}),
    err => {
      assert.ok(err instanceof BackendConfigError);
      assert.equal(err.code, 'CONFIG_INVALID');
      assert.deepEqual(err.invalid, ['RESOLVER_SECRET']);
      assert.equal(err.message, 'Invalid configuration: RESOLVER_SECRET');
      assert.ok(!err.message.includes(leakedResolverSecret));
      return true;
    },
  );

  // Production and mainnet modes are rejected (out of scope)
  for (const disallowedMode of ['production', 'mainnet', 'prod']) {
    assert.throws(
      () => resolveBackendConfig({BACKEND_ENV: disallowedMode}),
      err => {
        assert.ok(err instanceof BackendConfigError);
        assert.equal(err.code, 'CONFIG_INVALID');
        assert.deepEqual(err.invalid, ['BACKEND_ENV']);
        assert.equal(err.message, 'Invalid configuration: BACKEND_ENV');
        assert.ok(!err.message.includes(disallowedMode));
        return true;
      },
    );
  }

  // Non-HTTPS remote APP_ORIGIN and AI_ENDPOINT, malformed port and wallets report variable names only
  assert.throws(
    () => resolveBackendConfig({
      APP_ORIGIN: 'http://staging.revmarket.example',
      BACKEND_PORT: '70000',
      SUPER_ADMIN_WALLETS: 'NOT_A_STELLAR_KEY',
      AI_ENABLED: 'true',
      AI_ENDPOINT: 'http://remote-ai.example/v1/chat/completions',
      AI_API_KEY: 'bad key with spaces',
      AI_MODEL: 'gpt-4o-mini',
    }),
    err => {
      assert.ok(err instanceof BackendConfigError);
      assert.equal(err.code, 'CONFIG_INVALID');
      assert.deepEqual(err.invalid, ['APP_ORIGIN', 'BACKEND_PORT', 'SUPER_ADMIN_WALLETS', 'AI_ENDPOINT', 'AI_API_KEY']);
      assert.equal(
        err.message,
        'Invalid configuration: APP_ORIGIN, BACKEND_PORT, SUPER_ADMIN_WALLETS, AI_ENDPOINT, AI_API_KEY',
      );
      return true;
    },
  );
});

test('AC1: backend/server.mjs validates config before creating database files or listening', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'revmarket-cfg-fail-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const dbPath = join(dir, 'nested', 'should-not-exist.sqlite');
  const secretValue = 'DO_NOT_PRINT_SECRET_8888';

  const res = await spawnFailingServer({
    BACKEND_ENV: 'staging',
    BACKEND_DB: dbPath,
    PINATA_JWT: secretValue,
  });

  assert.equal(res.code, 1);
  assert.match(res.stderr, /Backend startup failed \[CONFIG_MISSING\]: Missing required configuration: APP_ORIGIN, BACKEND_PORT/);
  assert.ok(!res.stderr.includes(secretValue));
  assert.ok(!res.stdout.includes(secretValue));
  assert.equal(existsSync(dbPath), false, 'SQLite file must not be created when startup validation fails');
  assert.equal(existsSync(join(dir, 'nested')), false, 'Database directory must not be created when startup validation fails');
});

test('AC1, AC2 & AC3: clean staging deployment works with AI disabled, survives restart with data intact, wires optional AI, and rolls back cleanly', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'revmarket-staging-e2e-'));
  t.after(() => rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}));
  const dbPath = join(dir, 'db', 'revmarket.sqlite');
  const backupDir = join(dir, 'backups');
  await mkdir(backupDir, {recursive: true});
  const port = await freePort();
  const admin = Keypair.random();
  const creator = Keypair.random();
  const reviewer = Keypair.random();

  // Start staging server with AI disabled
  const baseEnv = {
    BACKEND_ENV: 'staging',
    APP_ORIGIN: STAGING_ORIGIN,
    BACKEND_DB: dbPath,
    BACKEND_PORT: String(port),
    SUPER_ADMIN_WALLETS: admin.publicKey(),
    AI_ENABLED: 'false',
  };
  const run1 = await startServerProcess(t, baseEnv, port);

  // Readiness exposed to host
  const health = await callApi(port, '/health', {origin: null});
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {
    status: 'ok',
    service: 'revmarket-api',
    version: 1,
    network: 'testnet',
    automationEnabled: false,
  });

  // Login creator, admin, reviewer
  async function login(key) {
    const ch = await callApi(port, '/auth/challenge', {method: 'POST', body: {wallet: key.publicKey()}});
    assert.equal(ch.status, 200);
    const vf = await callApi(port, '/auth/verify', {
      method: 'POST',
      body: {id: ch.body.id, signature: Buffer.from(key.signMessage(ch.body.message)).toString('base64')},
    });
    assert.equal(vf.status, 200);
    return vf.cookie;
  }

  const creatorCookie = await login(creator);
  const adminCookie = await login(admin);
  const reviewerCookie = await login(reviewer);

  // Manual drafting and review workflow with AI disabled
  const tradingClose = Math.floor(Date.now() / 1000) + 86_400;
  const resolutionDeadline = tradingClose + 86_400;
  assert.equal(
    (await callApi(port, '/admin/reviewers', {
      method: 'POST',
      cookie: adminCookie,
      body: {wallet: reviewer.publicKey(), action: 'add'},
    })).status,
    200,
  );

  const created = await callApi(port, '/drafts', {
    method: 'POST',
    cookie: creatorCookie,
    body: {
      question: 'Will XLM/USD exceed $0.50 on Testnet oracle snapshot?',
      category: 'crypto',
      tradingClose,
      observationTime: tradingClose,
      resolutionDeadline,
      yesRule: 'Median spot > $0.50',
      noRule: 'Median spot <= $0.50',
      sources: ['Coinbase', 'Kraken', 'CoinGecko'],
      unavailableDataRule: 'Resolve Invalid if the spot snapshot is unavailable by the resolution deadline.',
    },
  });
  assert.equal(created.status, 201);

  // AI assist returns 503 while disabled
  const aiDisabled = await callApi(port, `/drafts/${created.body.id}/ai-assist`, {
    method: 'POST',
    cookie: creatorCookie,
    body: {},
  });
  assert.equal(aiDisabled.status, 503);

  // Submit and approve manual draft
  const submitted = await callApi(port, `/drafts/${created.body.id}/submit`, {method: 'POST', cookie: creatorCookie, body: {}});
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.status, 'submitted');
  const approved = await callApi(port, `/drafts/${created.body.id}/review`, {
    method: 'POST',
    cookie: reviewerCookie,
    body: {decision: 'approved', reason: 'Clear resolution rules', expectedRevisionId: created.body.revisionId},
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.status, 'approved');

  // Graceful shutdown of process 1
  const exit1 = await run1.stopGracefully();
  assert.equal(exit1.code, 0);

  // Start local fixture AI endpoint and restart backend/server.mjs with AI enabled on the same database volume
  let receivedAuthHeader = null;
  let receivedModel = null;
  const aiServer = createHttpServer(async (req, res) => {
    receivedAuthHeader = req.headers.authorization;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    receivedModel = parsed.model;
    const suggestionPayload = JSON.stringify({
      suggestedQuestion: `Will XLM/USD close strictly above $0.50 at ${new Date(tradingClose * 1000).toISOString()}?`,
      suggestedYesRule: 'Median USD spot price across Coinbase, Kraken, CoinGecko > 0.50',
      suggestedNoRule: 'Median USD spot price <= 0.50',
      suggestedSources: ['Coinbase', 'Kraken', 'CoinGecko'],
      ambiguityFlags: [],
      duplicateCandidates: [],
      unresolved: [],
      confidence: 'high',
    });
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content: suggestionPayload}}]}));
  });
  await new Promise(r => aiServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { aiServer.close(r); aiServer.closeAllConnections(); }));
  const aiEndpoint = `http://127.0.0.1:${aiServer.address().port}/v1/chat/completions`;

  const run2 = await startServerProcess(t, {
    ...baseEnv,
    AI_ENABLED: 'true',
    AI_ENDPOINT: aiEndpoint,
    AI_API_KEY: 'staging-fixture-ai-key',
    AI_MODEL: 'staging-fixture-v1',
  }, port);

  // Verify previously approved manual draft and session survived process restart intact
  const persisted = await callApi(port, `/drafts/${created.body.id}`, {cookie: creatorCookie});
  assert.equal(persisted.status, 200);
  assert.equal(persisted.body.draft.status, 'approved');
  assert.equal(persisted.body.reviews.length, 1);
  assert.equal(persisted.body.reviews[0].revisionId, created.body.revisionId);
  assert.equal(persisted.body.reviews[0].approvedParamsHash, created.body.contentHash);

  // Verify wired AI configuration in backend/server.mjs works for an editable draft
  const draft2 = await callApi(port, '/drafts', {
    method: 'POST',
    cookie: creatorCookie,
    body: {question: 'Will XLM rise?', tradingClose},
  });
  assert.equal(draft2.status, 201);

  const aiResult = await callApi(port, `/drafts/${draft2.body.id}/ai-assist`, {
    method: 'POST',
    cookie: creatorCookie,
    body: {},
  });
  assert.equal(aiResult.status, 200);
  assert.equal(receivedAuthHeader, 'Bearer staging-fixture-ai-key');
  assert.equal(receivedModel, 'staging-fixture-v1');
  assert.equal(aiResult.body.suggestions.confidence, 'high');
  assert.equal(aiResult.body.suggestions.origin, 'ai_assisted');

  const draft2After = await callApi(port, `/drafts/${draft2.body.id}`, {cookie: creatorCookie});
  assert.equal(draft2After.body.draft.origin, 'ai_assisted');

  // Online backup before an unwanted post-backup write, then rollback via graceful shutdown + promoteRestore
  const backup = await createBackup({source: dbPath, outDir: backupDir});
  const badDraft = await callApi(port, '/drafts', {
    method: 'POST',
    cookie: creatorCookie,
    body: {question: 'Post-backup write to roll back', tradingClose},
  });
  assert.equal(badDraft.status, 201);
  assert.equal((await callApi(port, '/drafts', {cookie: creatorCookie})).body.drafts.length, 3);

  const verified = await verifyRestore({
    backup: backup.backupPath,
    target: join(dir, 'restore-verify'),
  });
  assert.equal(verified.report.ok, true);

  const exit2 = await run2.stopGracefully();
  assert.equal(exit2.code, 0);

  const promoted = await promoteRestore({target: verified.target, active: dbPath, port});
  assert.ok(promoted.preRestore.length >= 1);

  const run3 = await startServerProcess(t, baseEnv, port);
  const afterRollback = await callApi(port, '/drafts', {cookie: creatorCookie});
  assert.equal(afterRollback.status, 200);
  assert.equal(afterRollback.body.drafts.length, 2);
  const exit3 = await run3.stopGracefully();
  assert.equal(exit3.code, 0);
});

test('AC3: createGracefulShutdown drains in-flight requests before closing SQLite and is idempotent', async t => {
  const slowDb = openStore(':memory:');
  let releaseRequest;
  const requestEntered = new Promise(r => { releaseRequest = r; });
  let unblockHandler;
  const handlerGate = new Promise(r => { unblockHandler = r; });

  const slowServer = createHttpServer(async (_req, res) => {
    releaseRequest();
    await handlerGate;
    const row = slowDb.prepare('SELECT 1 AS ok').get();
    res.writeHead(200, {'Content-Type': 'application/json', Connection: 'close'});
    res.end(JSON.stringify(row));
  });
  await new Promise(r => slowServer.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { slowServer.close(() => r()); slowServer.closeAllConnections(); }));
  const slowPort = slowServer.address().port;
  const shutdown = createGracefulShutdown({server: slowServer, db: slowDb, shutdownTimeoutMs: 5000});

  const inflightFetch = fetch(`http://127.0.0.1:${slowPort}/slow`, {headers: {Connection: 'close'}});
  await requestEntered;

  // Trigger graceful shutdown while request is in flight; repeat call returns same promise
  const stopPromise = shutdown.stop();
  assert.equal(shutdown.stop(), stopPromise);
  assert.equal(shutdown.isStopping(), true);
  assert.equal(shutdown.isDbClosed(), false, 'DB must stay open while in-flight request drains');

  // Release the in-flight handler and verify it completes cleanly before DB closes
  unblockHandler();
  const inflightRes = await inflightFetch;
  assert.equal(inflightRes.status, 200);
  assert.deepEqual(await inflightRes.json(), {ok: 1});
  await stopPromise;
  assert.equal(shutdown.isDbClosed(), true);
});
