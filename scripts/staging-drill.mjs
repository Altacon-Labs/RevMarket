// Staging deployment, restart persistence, graceful shutdown and rollback drill.
// Runs entirely inside an isolated temporary directory with separate db, evidence, and backup volumes.
// Usage: node --experimental-sqlite scripts/staging-drill.mjs [--keep]
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {createServer as createHttpServer} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir, type, release, arch} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Keypair} from '@stellar/stellar-sdk';
import {createBackup, defaultProbe, promoteRestore, supportedSchemaVersion, verifyRestore} from '../backend/backup.mjs';
import {exportEvidence} from '../service/evidence-export.mjs';
import {runCli, UsageError} from './db-cli.mjs';

const serverScript = fileURLToPath(new URL('../backend/server.mjs', import.meta.url));
const fixtureEvidenceFile = fileURLToPath(
  new URL('../docs/smoke-evidence/7a52df7e56ccf05cef40ec4f8e2958f779b24824855a82091731e7d7a4360051.json', import.meta.url),
);
const FIXTURE_EVIDENCE_DIGEST = '7a52df7e56ccf05cef40ec4f8e2958f779b24824855a82091731e7d7a4360051';
const STAGING_ORIGIN = 'https://staging.revmarket.example';

const ms = t => Math.round(t * 100) / 100;
const sleep = n => new Promise(r => setTimeout(r, n));

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

function buildCleanEnv(overrides) {
  const base = {};
  for (const key of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'NODE_OPTIONS']) {
    if (process.env[key] !== undefined) base[key] = process.env[key];
  }
  return {...base, ...overrides};
}

const STARTUP_TIMEOUT_MS = 45_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const SIGNAL_TIMEOUT_MS = 2_000;

function spawnBackend(children, envOverrides, ipc = false) {
  const child = spawn(process.execPath, ['--experimental-sqlite', serverScript], {
    env: buildCleanEnv(envOverrides),
    stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  const backend = {child, stdout: '', stderr: '', result: undefined, error: undefined};
  child.on('error', error => { backend.error = error; });
  // close also fires after a spawn error and ensures captured output has drained.
  backend.closed = new Promise(resolve => child.once('close', (code, signal) => {
    backend.result = {code, signal};
    children.delete(backend);
    resolve(backend.result);
  }));
  children.add(backend);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  if (ipc) child.stdout.resume();
  else child.stdout.on('data', data => { backend.stdout += data; });
  child.stderr.on('data', data => { backend.stderr += data; });
  return backend;
}

async function waitForClose(backend, timeoutMs) {
  if (backend.result) return backend.result;
  let timer;
  try {
    return await Promise.race([
      backend.closed,
      new Promise(resolve => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function terminateBackend(backend) {
  if (backend.result) return backend.result;
  backend.child.kill('SIGTERM');
  const graceful = await waitForClose(backend, SIGNAL_TIMEOUT_MS);
  if (graceful) return graceful;

  backend.child.kill('SIGKILL');
  const forced = await waitForClose(backend, SIGNAL_TIMEOUT_MS);
  if (forced) return forced;
  throw new Error(`could not confirm staging backend termination for PID ${backend.child.pid} after SIGKILL`);
}

async function runFailingStartup(children, envOverrides) {
  const backend = spawnBackend(children, envOverrides);
  const result = await waitForClose(backend, STARTUP_TIMEOUT_MS);
  if (backend.error) throw backend.error;
  if (!result) throw new Error(`invalid-config backend did not exit within ${STARTUP_TIMEOUT_MS}ms`);
  return {code: result.code, stdout: backend.stdout, stderr: backend.stderr};
}

async function startStagingApi(children, envOverrides, port) {
  const backend = spawnBackend(children, envOverrides, true);
  const started = performance.now();
  while (performance.now() - started < STARTUP_TIMEOUT_MS) {
    if (backend.error) throw backend.error;
    if (backend.result) {
      const {code, signal} = backend.result;
      throw new Error(`staging backend exited during start (code ${code}, signal ${signal}): ${backend.stderr.trim()}`);
    }
    if ((await defaultProbe(port, {timeoutMs: 500})).up) {
      backend.startMs = ms(performance.now() - started);
      return backend;
    }
    await sleep(15);
  }
  throw new Error(`staging backend did not become ready within ${STARTUP_TIMEOUT_MS}ms: ${backend.stderr.trim()}`);
}

async function stopStagingApiGracefully(api, port) {
  const started = performance.now();
  if (api.child.connected) api.child.send('shutdown', error => { if (error) api.error = error; });
  else if (!api.result) api.child.kill('SIGTERM');
  const result = await waitForClose(api, SHUTDOWN_TIMEOUT_MS);
  if (!result) {
    throw new Error(`graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`);
  }
  if (api.error) throw api.error;
  const stopMs = ms(performance.now() - started);
  const probe = await defaultProbe(port, {timeoutMs: 500});
  if (probe.up) throw new Error('staging backend still answered health probe after graceful shutdown');
  if (result.code !== 0) {
    throw new Error(`graceful shutdown failed (exit code ${result.code}, signal ${result.signal})`);
  }
  return {stopMs, exitCode: result.code};
}

async function startFixtureAiServer(observationTime) {
  const server = createHttpServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    req.resume();
    const content = JSON.stringify({
      suggestedQuestion: `Will Stellar Testnet ledger protocol be >= 22 at ${new Date(observationTime * 1000).toISOString()}?`,
      suggestedYesRule: 'Observed Testnet protocolVersion >= 22 at observation time',
      suggestedNoRule: 'Observed Testnet protocolVersion < 22 at observation time',
      suggestedSources: ['Stellar Testnet Horizon', 'Soroban Testnet RPC'],
      ambiguityFlags: ['Specify exact UTC observation timestamp'],
      duplicateCandidates: [],
      unresolved: [],
      confidence: 'high',
    });
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({choices: [{message: {content}}]}));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const {port} = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    }),
  };
}

function tableCounts(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA query_only=1');
    return Object.fromEntries(
      db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all()
        .map(({name}) => [name, Number(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n)]),
    );
  } finally {
    db.close();
  }
}

async function apiCall(port, path, {method = 'GET', body, cookie, origin = STAGING_ORIGIN} = {}) {
  const headers = {Connection: 'close'};
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: await res.json(),
    cookie: res.headers.get('set-cookie')?.split(';')[0] || null,
  };
}

await runCli('staging:drill', async () => {
  const checkResults = {
    missingConfigNamesOnly: 'skipped',
    partialAiConfigNamesOnly: 'skipped',
    workerSecretRejectedOnApi: 'skipped',
    readinessExposedToHost: 'skipped',
    evidenceVolumePersistedAndExported: 'skipped',
    createDraftWithAiDisabled: 'skipped',
    aiDisabledReturns503: 'skipped',
    manualDraftingWithAiDisabled: 'skipped',
    restartPreservesDraftsAndSessions: 'skipped',
    wiredAiAssistWorksWhenConfigured: 'skipped',
    onlineBackup: 'skipped',
    postBackupMutation: 'skipped',
    verifyRestore: 'skipped',
    rollbackRestoresExactSnapshot: 'skipped',
  };
  let activeCheck;
  function passCheck() {
    checkResults[activeCheck] = 'passed';
    activeCheck = undefined;
  }
  const children = new Set();
  const cleanupErrors = [];
  let failure;
  let phase = 'setup';
  let dir;
  let keep = false;
  let api;
  let aiServer;
  let summary;

  try {
    try {
      ({values: {keep}} = parseArgs({strict: true, options: {keep: {type: 'boolean'}}}));
    } catch (error) {
      throw new UsageError(`${error.message}. Usage: staging:drill [--keep]`);
    }

    dir = await mkdtemp(join(tmpdir(), 'revmarket-staging-drill-'));
    const dbVolume = join(dir, 'volumes', 'db');
    const evidenceVolume = join(dir, 'volumes', 'evidence');
    const evidenceExportDir = join(dir, 'volumes', 'evidence-share');
    const backupVolume = join(dir, 'volumes', 'backups');
    await mkdir(dbVolume, {recursive: true});
    await mkdir(evidenceVolume, {recursive: true});
    await mkdir(evidenceExportDir, {recursive: true});
    await mkdir(backupVolume, {recursive: true});

    const dbPath = join(dbVolume, 'revmarket.sqlite');

    phase = 'workflow';
    // 1. Startup validation failure drills (variable names only, no secret leak, no DB created)
    const sentinelSecret = 'SECRET_VALUE_MUST_NEVER_APPEAR_987654';
    activeCheck = 'missingConfigNamesOnly';
    const missingStaging = await runFailingStartup(children, {
      BACKEND_ENV: 'staging',
      PINATA_JWT: sentinelSecret,
    });
    if (missingStaging.code !== 1) throw new Error('expected exit code 1 for missing staging variables');
    if (!missingStaging.stderr.includes('Missing required configuration: APP_ORIGIN, BACKEND_DB, BACKEND_PORT')) {
      throw new Error('missing-config startup did not report the expected variable names');
    }
    if (missingStaging.stderr.includes(sentinelSecret) || missingStaging.stdout.includes(sentinelSecret)) {
      throw new Error('startup validation leaked a secret value');
    }
    if (existsSync(dbPath)) throw new Error('database file was created despite startup config validation failure');

    passCheck();

    activeCheck = 'partialAiConfigNamesOnly';
    const partialAi = await runFailingStartup(children, {
      BACKEND_ENV: 'staging',
      APP_ORIGIN: STAGING_ORIGIN,
      BACKEND_DB: dbPath,
      BACKEND_PORT: '3001',
      AI_ENABLED: 'true',
      AI_API_KEY: sentinelSecret,
    });
    if (partialAi.code !== 1 || !partialAi.stderr.includes('Missing required configuration: AI_ENDPOINT, AI_MODEL')) {
      throw new Error('partial AI startup did not report the expected variable names');
    }
    if (partialAi.stderr.includes(sentinelSecret) || partialAi.stdout.includes(sentinelSecret)) {
      throw new Error('partial AI config error leaked AI_API_KEY');
    }

    passCheck();

    activeCheck = 'workerSecretRejectedOnApi';
    const leakedWorkerKey = await runFailingStartup(children, {
      BACKEND_ENV: 'staging',
      APP_ORIGIN: STAGING_ORIGIN,
      BACKEND_DB: dbPath,
      BACKEND_PORT: '3001',
      RESOLVER_SECRET: sentinelSecret,
    });
    if (leakedWorkerKey.code !== 1 || !leakedWorkerKey.stderr.includes('Invalid configuration: RESOLVER_SECRET')) {
      throw new Error('expected RESOLVER_SECRET rejection on API startup');
    }
    if (leakedWorkerKey.stderr.includes(sentinelSecret) || leakedWorkerKey.stdout.includes(sentinelSecret)) {
      throw new Error('RESOLVER_SECRET value leaked in API startup error');
    }

    passCheck();

    activeCheck = 'readinessExposedToHost';
    // 2. Clean staging startup with AI disabled + manual drafting + persistent evidence volume check
    const port = await freePort();
    const baseStagingEnv = {
      BACKEND_ENV: 'staging',
      APP_ORIGIN: STAGING_ORIGIN,
      BACKEND_DB: dbPath,
      BACKEND_PORT: String(port),
      AI_ENABLED: 'false',
    };
    api = await startStagingApi(children, baseStagingEnv, port);
    const initialStartMs = api.startMs;

    const health1 = await apiCall(port, '/health', {origin: null});
    if (health1.status !== 200 || health1.body.status !== 'ok' || health1.body.network !== 'testnet') {
      throw new Error('staging readiness health check failed');
    }

    passCheck();

    const creator = Keypair.random();
    const challenge = await apiCall(port, '/auth/challenge', {
      method: 'POST',
      body: {wallet: creator.publicKey()},
    });
    if (challenge.status !== 200) throw new Error('auth challenge failed');
    const verify = await apiCall(port, '/auth/verify', {
      method: 'POST',
      body: {
        id: challenge.body.id,
        signature: Buffer.from(creator.signMessage(challenge.body.message)).toString('base64'),
      },
    });
    if (verify.status !== 200 || !verify.cookie) throw new Error('auth verify failed');
    const cookie = verify.cookie;

    const tradingClose = Math.floor(Date.now() / 1000) + 86_400;
    const resolutionFields = {
      tradingClose,
      observationTime: tradingClose,
      resolutionDeadline: tradingClose + 86_400,
      yesRule: 'Settled YES on-chain',
      noRule: 'Settled NO on-chain',
      sources: ['https://soroban-testnet.stellar.org'],
      unavailableDataRule: 'Resolve Invalid if the on-chain settlement data is unavailable by the resolution deadline.',
    };
    activeCheck = 'createDraftWithAiDisabled';
    const createdDraft = await apiCall(port, '/drafts', {
      method: 'POST',
      cookie,
      body: {
        question: 'Will Stellar Testnet settle market 1 before deadline?',
        category: 'network',
        ...resolutionFields,
      },
    });
    if (createdDraft.status !== 201) throw new Error('manual draft creation failed with AI disabled');
    const draftId = createdDraft.body.id;
    passCheck();

    activeCheck = 'aiDisabledReturns503';
    const aiDisabledResp = await apiCall(port, `/drafts/${draftId}/ai-assist`, {
      method: 'POST',
      cookie,
      body: {},
    });
    if (aiDisabledResp.status !== 503) {
      throw new Error(`expected 503 when AI is disabled, got ${aiDisabledResp.status}`);
    }
    passCheck();

    activeCheck = 'manualDraftingWithAiDisabled';
    const revisedDraft = await apiCall(port, `/drafts/${draftId}`, {
      method: 'PUT',
      cookie,
      body: {
        question: 'Will Stellar Testnet settle market 1 before the resolution deadline?',
        category: 'network',
        ...resolutionFields,
        expectedRevisionId: createdDraft.body.revisionId,
      },
    });
    if (revisedDraft.status !== 200 || revisedDraft.body.revisionNumber !== 2 ||
        !Number.isSafeInteger(revisedDraft.body.revisionId) || revisedDraft.body.revisionId === createdDraft.body.revisionId) {
      throw new Error(`manual draft revision update failed (HTTP ${revisedDraft.status})`);
    }
    const revisionId = revisedDraft.body.revisionId;

    const submittedDraft = await apiCall(port, `/drafts/${draftId}/submit`, {
      method: 'POST',
      cookie,
      body: {},
    });
    if (submittedDraft.status !== 200 || submittedDraft.body.status !== 'submitted') {
      throw new Error(`manual draft submit failed (HTTP ${submittedDraft.status})`);
    }
    passCheck();

    // Populate persistent evidence volume and verify digest-bound export
    activeCheck = 'evidenceVolumePersistedAndExported';
    const evidenceBytes = await readFile(fixtureEvidenceFile);
    await writeFile(join(evidenceVolume, `${FIXTURE_EVIDENCE_DIGEST}.json`), evidenceBytes, {flag: 'wx', mode: 0o600});
    const exportedEvidence = await exportEvidence({
      root: evidenceVolume,
      digest: FIXTURE_EVIDENCE_DIGEST,
      out: evidenceExportDir,
    });

    if (exportedEvidence.digest !== FIXTURE_EVIDENCE_DIGEST) throw new Error('exported evidence digest mismatch');
    passCheck();

    // 3. Graceful shutdown and process restart with persistent volumes intact + optional AI wired
    activeCheck = 'restartPreservesDraftsAndSessions';
    const firstShutdown = await stopStagingApiGracefully(api, port);
    api = undefined;

    aiServer = await startFixtureAiServer(tradingClose);
    api = await startStagingApi(children, {
      ...baseStagingEnv,
      AI_ENABLED: 'true',
      AI_ENDPOINT: aiServer.endpoint,
      AI_API_KEY: 'fixture-staging-ai-key',
      AI_MODEL: 'fixture-staging-model',
    }, port);
    const restartMs = api.startMs;

    const persistedDraft = await apiCall(port, `/drafts/${draftId}`, {cookie});
    if (
      persistedDraft.status !== 200 ||
      persistedDraft.body.draft.status !== 'submitted' ||
      persistedDraft.body.revisions.length !== 2 ||
      persistedDraft.body.revisions[0].id !== revisionId ||
      persistedDraft.body.revisions[0].contentHash !== revisedDraft.body.contentHash
    ) {
      throw new Error('persisted draft state did not survive process restart');
    }
    passCheck();

    activeCheck = 'wiredAiAssistWorksWhenConfigured';
    const aiDraft = await apiCall(port, '/drafts', {
      method: 'POST',
      cookie,
      body: {
        question: 'Will Testnet protocol stay current?',
        category: 'network',
        tradingClose,
      },
    });
    if (aiDraft.status !== 201) throw new Error('second draft creation failed');
    const aiAssist = await apiCall(port, `/drafts/${aiDraft.body.id}/ai-assist`, {
      method: 'POST',
      cookie,
      body: {expectedRevisionId: aiDraft.body.revisionId},
    });
    if (aiAssist.status !== 200) {
      throw new Error(`expected HTTP 200 from wired AI assist after restart, got ${aiAssist.status}`);
    }
    const aiRevisionId = aiAssist.body?.sourceRevision?.revisionId;
    if (aiRevisionId !== aiDraft.body.revisionId) {
      throw new Error(`wired AI assist revision mismatch: expected ${aiDraft.body.revisionId}, got ${aiRevisionId}`);
    }
    const confidence = aiAssist.body?.suggestions?.confidence;
    if (confidence !== 'high') {
      throw new Error(`wired AI assist confidence mismatch: expected high, got ${JSON.stringify(confidence)}`);
    }
    passCheck();

    // 4. Online backup, post-backup mutation, guarded promote refusal while running, shutdown, rollback promote, restart
    activeCheck = 'onlineBackup';
    const tBackup = performance.now();
    const backup = await createBackup({source: dbPath, outDir: backupVolume});
    const backupMs = ms(performance.now() - tBackup);
    passCheck();

    // Post-backup mutation that will be rolled back
    activeCheck = 'postBackupMutation';
    const unwantedDraft = await apiCall(port, '/drafts', {
      method: 'POST',
      cookie,
      body: {
        question: 'Unwanted post-backup draft to roll back',
        tradingClose,
      },
    });
    if (unwantedDraft.status !== 201) throw new Error('post-backup mutation failed');
    passCheck();

    activeCheck = 'verifyRestore';
    const tVerify = performance.now();
    const verified = await verifyRestore({
      backup: backup.backupPath,
      target: join(dir, 'volumes', 'restore-check-1'),
    });
    const verifyMs = ms(performance.now() - tVerify);
    if (!verified.report.ok) throw new Error('restore verification failed');
    passCheck();

    // Promote must refuse while the staging API is still running
    activeCheck = 'rollbackRestoresExactSnapshot';
    let promoteRefusedCode = null;
    try {
      await promoteRestore({target: verified.target, active: dbPath, port});
    } catch (e) {
      if (e.code !== 'API_RUNNING') throw e;
      promoteRefusedCode = e.code;
    }
    if (promoteRefusedCode !== 'API_RUNNING') {
      throw new Error(`expected API_RUNNING when promoting against live staging API, got ${promoteRefusedCode}`);
    }

    const preRollbackStop = await stopStagingApiGracefully(api, port);
    api = undefined;

    const promoted = await promoteRestore({target: verified.target, active: dbPath, port});
    api = await startStagingApi(children, baseStagingEnv, port);
    const postRollbackStartMs = api.startMs;

    const rolledBackList = await apiCall(port, '/drafts', {cookie});
    const restoredDraftIds = rolledBackList.body.drafts?.map(draft => draft.id) ?? [];
    if (rolledBackList.status !== 200 || restoredDraftIds.length !== 2 ||
        !restoredDraftIds.includes(draftId) || !restoredDraftIds.includes(aiDraft.body.id)) {
      throw new Error('rollback did not restore the two pre-backup drafts');
    }

    const finalStop = await stopStagingApiGracefully(api, port);
    api = undefined;

    const afterCounts = tableCounts(dbPath);
    const countsMatchManifest = Object.entries(backup.manifest.tables).every(([name, n]) => afterCounts[name] === n);
    if (!countsMatchManifest) {
      throw new Error('rolled-back database table counts do not match backup manifest');
    }
    passCheck();

    summary = {
      note: 'Isolated staging deployment, restart persistence, graceful shutdown and backup rollback drill using the real backend/server.mjs process and local fixture AI transport.',
      environment: {
        node: process.version,
        os: `${type()} ${release()} ${arch()}`,
        schemaVersion: supportedSchemaVersion(),
      },
      checks: {
        ...Object.fromEntries(Object.entries(checkResults).map(([name, status]) => [name, status === 'passed'])),
        noSecretLeakInStderr: ['missingConfigNamesOnly', 'partialAiConfigNamesOnly', 'workerSecretRejectedOnApi']
          .every(name => checkResults[name] === 'passed'),
        promoteRefusedWhileApiRunning: promoteRefusedCode,
        preRestoreFilesRetained: promoted.preRestore.length,
        gracefulShutdownExitCodes: [firstShutdown.exitCode, preRollbackStop.exitCode, finalStop.exitCode],
      },
      timingsMs: {
        initialStart: initialStartMs,
        firstGracefulShutdown: firstShutdown.stopMs,
        restartWithAi: restartMs,
        backup: backupMs,
        verifyRestore: verifyMs,
        preRollbackShutdown: preRollbackStop.stopMs,
        promote: promoted.timingsMs,
        postRollbackRestart: postRollbackStartMs,
        finalGracefulShutdown: finalStop.stopMs,
        cutoverDowntime: ms(preRollbackStop.stopMs + promoted.timingsMs.total + postRollbackStartMs),
      },
    };
  } catch (error) {
    if (activeCheck) checkResults[activeCheck] = 'failed';
    failure = {phase, error};
  }

  for (const backend of children) {
    try {
      await terminateBackend(backend);
    } catch (error) {
      cleanupErrors.push(error);
      // Preserve the directory and let the CLI finish even if a child cannot be reaped.
      if (backend.child.connected) backend.child.disconnect();
      backend.child.stdout.destroy();
      backend.child.stderr.destroy();
      backend.child.unref();
    }
  }
  if (aiServer) {
    try {
      await aiServer.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (dir) {
    if (keep || children.size) {
      process.stderr.write(`staging:drill: kept ${dir}\n`);
    } else {
      try {
        await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  failure ??= cleanupErrors.length ? {phase: 'cleanup', error: cleanupErrors[0]} : undefined;
  process.stdout.write(JSON.stringify({
    source: 'fixture',
    outcome: failure ? 'failed' : 'passed',
    checkResults,
    ...summary,
    ...(failure && {
      failure: {phase: failure.phase, message: failure.error.message},
      cleanupErrors: cleanupErrors.map(error => error.message),
    }),
  }, null, 2) + '\n');
  if (failure) throw failure.error;
});
