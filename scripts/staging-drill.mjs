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

function runFailingStartup(envOverrides) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, ['--experimental-sqlite', serverScript], {
      env: buildCleanEnv(envOverrides),
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

async function startStagingApi(envOverrides, port) {
  const child = spawn(process.execPath, ['--experimental-sqlite', serverScript], {
    env: buildCleanEnv(envOverrides),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr += d; });
  const exited = new Promise(r => child.once('exit', (code, signal) => r({code, signal})));
  const t = performance.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`staging backend exited during start (${child.exitCode}): ${stderr.trim()}`);
    }
    if ((await defaultProbe(port, {timeoutMs: 500})).up) break;
    if (performance.now() - t > 45_000) {
      child.kill();
      throw new Error(`staging backend did not become ready within 45s: ${stderr.trim()}`);
    }
    await sleep(15);
  }
  return {child, exited, startMs: ms(performance.now() - t)};
}

async function stopStagingApiGracefully(api, port) {
  const t = performance.now();
  if (api.child.connected) {
    api.child.send('shutdown');
  } else {
    api.child.kill('SIGTERM');
  }
  const timeout = setTimeout(() => {
    if (api.child.exitCode === null) api.child.kill();
  }, 5000);
  timeout.unref();
  const exitResult = await api.exited;
  clearTimeout(timeout);
  const stopMs = ms(performance.now() - t);
  const probe = await defaultProbe(port, {timeoutMs: 500});
  if (probe.up) throw new Error('staging backend still answered health probe after graceful shutdown');
  return {stopMs, exitCode: exitResult.code};
}

async function startFixtureAiServer() {
  const server = createHttpServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    req.resume();
    const content = JSON.stringify({
      suggestedQuestion: 'Will Stellar Testnet ledger protocol remain >= 22 through Q4 2026?',
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
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  return {
    endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }),
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
  let values;
  try {
    ({values} = parseArgs({strict: true, options: {keep: {type: 'boolean'}}}));
  } catch (e) {
    throw new UsageError(`${e.message}. Usage: staging:drill [--keep]`);
  }

  const dir = await mkdtemp(join(tmpdir(), 'revmarket-staging-drill-'));
  const dbVolume = join(dir, 'volumes', 'db');
  const evidenceVolume = join(dir, 'volumes', 'evidence');
  const evidenceExportDir = join(dir, 'volumes', 'evidence-share');
  const backupVolume = join(dir, 'volumes', 'backups');
  await mkdir(dbVolume, {recursive: true});
  await mkdir(evidenceVolume, {recursive: true});
  await mkdir(evidenceExportDir, {recursive: true});
  await mkdir(backupVolume, {recursive: true});

  const dbPath = join(dbVolume, 'revmarket.sqlite');
  let api;
  let aiServer;

  try {
    // 1. Startup validation failure drills (variable names only, no secret leak, no DB created)
    const sentinelSecret = 'SECRET_VALUE_MUST_NEVER_APPEAR_987654';
    const missingStaging = await runFailingStartup({
      BACKEND_ENV: 'staging',
      PINATA_JWT: sentinelSecret,
    });
    if (missingStaging.code !== 1) throw new Error('expected exit code 1 for missing staging variables');
    if (!missingStaging.stderr.includes('Missing required configuration: APP_ORIGIN, BACKEND_DB, BACKEND_PORT')) {
      throw new Error(`unexpected missing-config message: ${missingStaging.stderr}`);
    }
    if (missingStaging.stderr.includes(sentinelSecret) || missingStaging.stdout.includes(sentinelSecret)) {
      throw new Error('startup validation leaked a secret value');
    }
    if (existsSync(dbPath)) throw new Error('database file was created despite startup config validation failure');

    const partialAi = await runFailingStartup({
      BACKEND_ENV: 'staging',
      APP_ORIGIN: STAGING_ORIGIN,
      BACKEND_DB: dbPath,
      BACKEND_PORT: '3001',
      AI_ENABLED: 'true',
      AI_API_KEY: sentinelSecret,
    });
    if (partialAi.code !== 1 || !partialAi.stderr.includes('Missing required configuration: AI_ENDPOINT, AI_MODEL')) {
      throw new Error(`unexpected partial-AI failure: ${partialAi.stderr}`);
    }
    if (partialAi.stderr.includes(sentinelSecret)) {
      throw new Error('partial AI config error leaked AI_API_KEY');
    }

    const leakedWorkerKey = await runFailingStartup({
      BACKEND_ENV: 'staging',
      APP_ORIGIN: STAGING_ORIGIN,
      BACKEND_DB: dbPath,
      BACKEND_PORT: '3001',
      RESOLVER_SECRET: sentinelSecret,
    });
    if (leakedWorkerKey.code !== 1 || !leakedWorkerKey.stderr.includes('Invalid configuration: RESOLVER_SECRET')) {
      throw new Error(`expected RESOLVER_SECRET rejection on API startup, got: ${leakedWorkerKey.stderr}`);
    }
    if (leakedWorkerKey.stderr.includes(sentinelSecret)) {
      throw new Error('RESOLVER_SECRET value leaked in API startup error');
    }

    // 2. Clean staging startup with AI disabled + manual drafting + persistent evidence volume check
    const port = await freePort();
    const baseStagingEnv = {
      BACKEND_ENV: 'staging',
      APP_ORIGIN: STAGING_ORIGIN,
      BACKEND_DB: dbPath,
      BACKEND_PORT: String(port),
      AI_ENABLED: 'false',
    };
    api = await startStagingApi(baseStagingEnv, port);
    const initialStartMs = api.startMs;

    const health1 = await apiCall(port, '/health', {origin: null});
    if (health1.status !== 200 || health1.body.status !== 'ok' || health1.body.network !== 'testnet') {
      throw new Error('staging readiness health check failed');
    }

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

    const createdDraft = await apiCall(port, '/drafts', {
      method: 'POST',
      cookie,
      body: {
        question: 'Will Stellar Testnet settle market 1 before deadline?',
        category: 'network',
        tradingClose: 2_000_000_000,
        yesRule: 'Settled YES on-chain',
        noRule: 'Settled NO on-chain',
        sources: ['https://soroban-testnet.stellar.org'],
      },
    });
    if (createdDraft.status !== 201) throw new Error('manual draft creation failed with AI disabled');
    const draftId = createdDraft.body.id;

    const aiDisabledResp = await apiCall(port, `/drafts/${draftId}/ai-assist`, {
      method: 'POST',
      cookie,
      body: {},
    });
    if (aiDisabledResp.status !== 503) {
      throw new Error(`expected 503 when AI is disabled, got ${aiDisabledResp.status}`);
    }

    const revisedDraft = await apiCall(port, `/drafts/${draftId}`, {
      method: 'PUT',
      cookie,
      body: {
        question: 'Will Stellar Testnet settle market 1 before the resolution deadline?',
        category: 'network',
        tradingClose: 2_000_000_000,
        yesRule: 'Settled YES on-chain',
        noRule: 'Settled NO on-chain',
        sources: ['https://soroban-testnet.stellar.org'],
      },
    });
    if (revisedDraft.status !== 200 || revisedDraft.body.revisionNumber !== 2) {
      throw new Error('manual draft revision update failed');
    }

    const submittedDraft = await apiCall(port, `/drafts/${draftId}/submit`, {
      method: 'POST',
      cookie,
      body: {},
    });
    if (submittedDraft.status !== 200 || submittedDraft.body.status !== 'submitted') {
      throw new Error('manual draft submit failed');
    }

    // Populate persistent evidence volume and verify digest-bound export
    const evidenceBytes = await readFile(fixtureEvidenceFile);
    await writeFile(join(evidenceVolume, `${FIXTURE_EVIDENCE_DIGEST}.json`), evidenceBytes, {flag: 'wx', mode: 0o600});
    const exportedEvidence = await exportEvidence({
      root: evidenceVolume,
      digest: FIXTURE_EVIDENCE_DIGEST,
      out: evidenceExportDir,
    });

    // 3. Graceful shutdown and process restart with persistent volumes intact + optional AI wired
    const firstShutdown = await stopStagingApiGracefully(api, port);
    api = undefined;

    aiServer = await startFixtureAiServer();
    api = await startStagingApi({
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
      persistedDraft.body.revisions[0].contentHash !== revisedDraft.body.contentHash
    ) {
      throw new Error('persisted draft state did not survive process restart');
    }

    const aiDraft = await apiCall(port, '/drafts', {
      method: 'POST',
      cookie,
      body: {
        question: 'Will Testnet protocol stay current?',
        category: 'network',
        tradingClose: 2_000_000_000,
      },
    });
    if (aiDraft.status !== 201) throw new Error('second draft creation failed');
    const aiAssist = await apiCall(port, `/drafts/${aiDraft.body.id}/ai-assist`, {
      method: 'POST',
      cookie,
      body: {},
    });
    if (aiAssist.status !== 200 || aiAssist.body.suggestions.confidence !== 'high') {
      throw new Error(`expected 200 from wired AI assist after restart, got ${aiAssist.status}`);
    }

    // 4. Online backup, post-backup mutation, guarded promote refusal while running, shutdown, rollback promote, restart
    const tBackup = performance.now();
    const backup = await createBackup({source: dbPath, outDir: backupVolume});
    const backupMs = ms(performance.now() - tBackup);

    // Post-backup mutation that will be rolled back
    const unwantedDraft = await apiCall(port, '/drafts', {
      method: 'POST',
      cookie,
      body: {
        question: 'Unwanted post-backup draft to roll back',
        tradingClose: 2_000_000_000,
      },
    });
    if (unwantedDraft.status !== 201) throw new Error('post-backup mutation failed');

    const tVerify = performance.now();
    const verified = await verifyRestore({
      backup: backup.backupPath,
      target: join(dir, 'volumes', 'restore-check-1'),
    });
    const verifyMs = ms(performance.now() - tVerify);

    // Promote must refuse while the staging API is still running
    let promoteRefusedCode = null;
    try {
      await promoteRestore({target: verified.target, active: dbPath, port});
    } catch (e) {
      promoteRefusedCode = e.code;
    }
    if (promoteRefusedCode !== 'API_RUNNING') {
      throw new Error(`expected API_RUNNING when promoting against live staging API, got ${promoteRefusedCode}`);
    }

    const preRollbackStop = await stopStagingApiGracefully(api, port);
    api = undefined;

    const promoted = await promoteRestore({target: verified.target, active: dbPath, port});
    api = await startStagingApi(baseStagingEnv, port);
    const postRollbackStartMs = api.startMs;

    const rolledBackList = await apiCall(port, '/drafts', {cookie});
    if (rolledBackList.status !== 200 || rolledBackList.body.drafts.length !== 2) {
      throw new Error(`expected 2 drafts after rollback to backup snapshot, got ${rolledBackList.body?.drafts?.length}`);
    }

    const finalStop = await stopStagingApiGracefully(api, port);
    api = undefined;

    const afterCounts = tableCounts(dbPath);
    const countsMatchManifest = Object.entries(backup.manifest.tables).every(([name, n]) => afterCounts[name] === n);
    if (!countsMatchManifest) {
      throw new Error('rolled-back database table counts do not match backup manifest');
    }

    const summary = {
      source: 'fixture',
      note: 'Isolated staging deployment, restart persistence, graceful shutdown and backup rollback drill using the real backend/server.mjs process and local fixture AI transport.',
      environment: {
        node: process.version,
        os: `${type()} ${release()} ${arch()}`,
        schemaVersion: supportedSchemaVersion(),
      },
      checks: {
        missingConfigNamesOnly: true,
        partialAiConfigNamesOnly: true,
        workerSecretRejectedOnApi: true,
        noSecretLeakInStderr: true,
        manualDraftingWithAiDisabled: true,
        aiDisabledReturns503: true,
        readinessExposedToHost: true,
        restartPreservesDraftsAndSessions: true,
        evidenceVolumePersistedAndExported: exportedEvidence.digest === FIXTURE_EVIDENCE_DIGEST,
        wiredAiAssistWorksWhenConfigured: true,
        promoteRefusedWhileApiRunning: promoteRefusedCode,
        rollbackRestoresExactSnapshot: countsMatchManifest,
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
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } finally {
    if (api) {
      api.child.kill();
      await api.exited;
    }
    if (aiServer) {
      await aiServer.close();
    }
    if (values.keep) {
      process.stderr.write(`staging:drill: kept ${dir}\n`);
    } else {
      await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    }
  }
});
