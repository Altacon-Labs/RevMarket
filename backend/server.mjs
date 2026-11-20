import {mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createGracefulShutdown, resolveBackendConfig} from './config.mjs';

let config;
try {
  config = resolveBackendConfig(process.env);
} catch (err) {
  const code = err?.code || 'CONFIG_ERROR';
  process.stderr.write(`Backend startup failed [${code}]: ${err.message}\n`);
  process.exit(1);
}

const [{openStore}, {createApi}, {validateVerifiedActivityConfig}] = await Promise.all([
  import('./store.mjs'),
  import('./app.mjs'),
  import('./verified-activity.mjs'),
]);

const contractId = (process.env.CONTRACT_ID || '').trim() || undefined;
const rawStaleAfter = (process.env.INDEXER_STALE_AFTER_SECONDS ?? '').trim();
const staleAfterSeconds = rawStaleAfter !== '' ? Number(rawStaleAfter) : undefined;
try {
  validateVerifiedActivityConfig({contractId, staleAfterSeconds});
} catch (err) {
  const varName = String(err?.message || '').includes('CONTRACT_ID') ? 'CONTRACT_ID' : 'INDEXER_STALE_AFTER_SECONDS';
  process.stderr.write(`Backend startup failed [CONFIG_INVALID]: Invalid configuration: ${varName}\n`);
  process.exit(1);
}

if (config.filename !== ':memory:') {
  await mkdir(dirname(config.filename), {recursive: true});
}
const db = openStore(config.filename);
const server = createApi({
  db,
  appOrigin: config.appOrigin,
  superAdminWallets: config.superAdminWallets,
  pinataJwt: config.pinataJwt,
  aiConfig: config.aiConfig,
  contractId,
  staleAfterSeconds,
});
const shutdown = createGracefulShutdown({
  server,
  db,
  shutdownTimeoutMs: config.shutdownTimeoutMs,
});
server.on('error', () => {
  console.error('Backend could not listen; check local port and configuration');
  try {
    db.close();
  } catch {
    // ignore close error
  }
  process.exitCode = 1;
});
const displayHost = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
server.listen(config.port, config.host, () => {
  console.log(`RevMarket backend: http://${displayHost}:${config.port}/api/health`);
});
function handleSignal() {
  shutdown.stop().then(() => {
    if (typeof process.disconnect === 'function' && process.connected) {
      process.disconnect();
    }
  });
}
process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);
process.on('message', msg => {
  if (msg === 'shutdown' || msg?.type === 'shutdown') {
    handleSignal();
  }
});
