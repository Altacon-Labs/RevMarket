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

const [{openStore}, {createApi}] = await Promise.all([
  import('./store.mjs'),
  import('./app.mjs'),
]);

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
