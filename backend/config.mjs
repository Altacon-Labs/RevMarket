import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

export const DEFAULT_LOCAL_ORIGIN = 'http://127.0.0.1:5173';
export const DEFAULT_LOCAL_PORT = 3001;
export const DEFAULT_LOCAL_HOST = '127.0.0.1';
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5000;
export const DEFAULT_LOCAL_DB = fileURLToPath(new URL('./data/revmarket.sqlite', import.meta.url));

const ALLOWED_MODES = new Set(['local', 'staging']);
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0']);
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function isValidEd25519PublicKey(str) {
  if (typeof str !== 'string' || str.length !== 56) return false;
  const bytes = new Uint8Array(35);
  let buffer = 0;
  let bitsLeft = 0;
  let index = 0;
  for (let i = 0; i < 56; i++) {
    const val = BASE32_ALPHABET.indexOf(str[i]);
    if (val === -1) return false;
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes[index++] = (buffer >> bitsLeft) & 0xff;
    }
  }
  if (bytes[0] !== (6 << 3)) return false;
  let crc = 0x0000;
  for (let i = 0; i < 33; i++) {
    crc ^= bytes[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  const expected = bytes[33] | (bytes[34] << 8);
  return crc === expected;
}

/**
 * Configuration error that formats only variable names in its message.
 * Never includes environment values or secrets.
 */
export class BackendConfigError extends Error {
  constructor(code, variables) {
    const list = [...new Set(variables)];
    const prefix = code === 'CONFIG_MISSING'
      ? 'Missing required configuration'
      : 'Invalid configuration';
    super(`${prefix}: ${list.join(', ')}`);
    this.name = 'BackendConfigError';
    this.code = code;
    this.variables = list;
    if (code === 'CONFIG_MISSING') this.missing = list;
    else this.invalid = list;
  }
}

function isValidHttpOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.origin !== value || parsed.username || parsed.password) return false;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
  return true;
}

function isValidAiEndpoint(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTNAMES.has(parsed.hostname)) return false;
  return true;
}

/**
 * Validate and resolve backend startup configuration from an environment object.
 * Fails before opening any database or listening on any socket.
 * Error messages report offending variable names only.
 */
export function resolveBackendConfig(env = process.env, options = {}) {
  if (!env || typeof env !== 'object') {
    throw new BackendConfigError('CONFIG_MISSING', ['APP_ORIGIN', 'BACKEND_DB', 'BACKEND_PORT']);
  }

  const missing = [];
  const invalid = [];

  // 1. Operating mode (local vs staging; production/mainnet are outside scope)
  let mode = 'local';
  if (options.mode !== undefined) {
    mode = String(options.mode).trim();
    if (!ALLOWED_MODES.has(mode)) invalid.push('BACKEND_ENV');
  } else if (env.BACKEND_ENV !== undefined) {
    const rawMode = String(env.BACKEND_ENV).trim();
    if (!rawMode) missing.push('BACKEND_ENV');
    else if (!ALLOWED_MODES.has(rawMode)) invalid.push('BACKEND_ENV');
    else mode = rawMode;
  }

  const requireExplicit = mode === 'staging' || options.requireExplicit === true;

  // Enforce API / settlement worker credential separation: RESOLVER_SECRET must never be loaded into the HTTP API.
  if (env.RESOLVER_SECRET !== undefined && String(env.RESOLVER_SECRET).trim() !== '') {
    invalid.push('RESOLVER_SECRET');
  }

  // 2. APP_ORIGIN
  let appOrigin = DEFAULT_LOCAL_ORIGIN;
  if (env.APP_ORIGIN === undefined) {
    if (requireExplicit) missing.push('APP_ORIGIN');
  } else {
    const rawOrigin = String(env.APP_ORIGIN).trim();
    if (!rawOrigin) missing.push('APP_ORIGIN');
    else if (!isValidHttpOrigin(rawOrigin)) invalid.push('APP_ORIGIN');
    else appOrigin = rawOrigin;
  }

  // 3. BACKEND_DB
  let filename = DEFAULT_LOCAL_DB;
  if (env.BACKEND_DB === undefined) {
    if (requireExplicit) missing.push('BACKEND_DB');
  } else {
    const rawDb = String(env.BACKEND_DB).trim();
    if (!rawDb) missing.push('BACKEND_DB');
    else if (rawDb.includes('\0')) invalid.push('BACKEND_DB');
    else filename = rawDb === ':memory:' ? ':memory:' : resolve(rawDb);
  }

  // 4. BACKEND_PORT
  let port = DEFAULT_LOCAL_PORT;
  if (env.BACKEND_PORT === undefined) {
    if (requireExplicit) missing.push('BACKEND_PORT');
  } else {
    const rawPort = String(env.BACKEND_PORT).trim();
    if (!rawPort) {
      missing.push('BACKEND_PORT');
    } else {
      const parsedPort = Number(rawPort);
      if (!/^\d+$/.test(rawPort) || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        invalid.push('BACKEND_PORT');
      } else {
        port = parsedPort;
      }
    }
  }

  // 5. BACKEND_HOST
  let host = DEFAULT_LOCAL_HOST;
  if (env.BACKEND_HOST !== undefined) {
    const rawHost = String(env.BACKEND_HOST).trim();
    if (!rawHost) missing.push('BACKEND_HOST');
    else if (!ALLOWED_HOSTS.has(rawHost)) invalid.push('BACKEND_HOST');
    else host = rawHost;
  }

  // 6. BACKEND_SHUTDOWN_TIMEOUT_MS
  let shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (env.BACKEND_SHUTDOWN_TIMEOUT_MS !== undefined) {
    const rawTimeout = String(env.BACKEND_SHUTDOWN_TIMEOUT_MS).trim();
    if (!rawTimeout) {
      missing.push('BACKEND_SHUTDOWN_TIMEOUT_MS');
    } else {
      const parsedTimeout = Number(rawTimeout);
      if (!/^\d+$/.test(rawTimeout) || !Number.isInteger(parsedTimeout) || parsedTimeout < 100 || parsedTimeout > 120_000) {
        invalid.push('BACKEND_SHUTDOWN_TIMEOUT_MS');
      } else {
        shutdownTimeoutMs = parsedTimeout;
      }
    }
  }

  // 7. SUPER_ADMIN_WALLETS (optional)
  let superAdminWallets = [];
  if (env.SUPER_ADMIN_WALLETS !== undefined && String(env.SUPER_ADMIN_WALLETS).trim() !== '') {
    const entries = String(env.SUPER_ADMIN_WALLETS).split(',').map(w => w.trim());
    if (entries.some(w => !w || !isValidEd25519PublicKey(w))) {
      invalid.push('SUPER_ADMIN_WALLETS');
    } else {
      superAdminWallets = entries;
    }
  }

  // 8. PINATA_JWT (optional)
  let pinataJwt = '';
  if (env.PINATA_JWT !== undefined && String(env.PINATA_JWT).trim() !== '') {
    const rawJwt = String(env.PINATA_JWT).trim();
    if (/\s/.test(rawJwt)) invalid.push('PINATA_JWT');
    else pinataJwt = rawJwt;
  }

  // 9. Optional AI configuration (AI_ENABLED, AI_ENDPOINT, AI_API_KEY, AI_MODEL)
  const rawAiEnabled = env.AI_ENABLED !== undefined ? String(env.AI_ENABLED).trim().toLowerCase() : undefined;
  const aiEndpoint = env.AI_ENDPOINT !== undefined ? String(env.AI_ENDPOINT).trim() : '';
  const aiApiKey = env.AI_API_KEY !== undefined ? String(env.AI_API_KEY).trim() : '';
  const aiModel = env.AI_MODEL !== undefined ? String(env.AI_MODEL).trim() : '';

  let aiEnabled = false;
  if (rawAiEnabled !== undefined && rawAiEnabled !== '') {
    if (rawAiEnabled === 'true' || rawAiEnabled === '1') {
      aiEnabled = true;
    } else if (rawAiEnabled === 'false' || rawAiEnabled === '0') {
      aiEnabled = false;
    } else {
      invalid.push('AI_ENABLED');
    }
  } else {
    aiEnabled = Boolean(aiEndpoint || aiApiKey || aiModel);
  }

  let aiConfig = null;
  if (aiEnabled) {
    if (!aiEndpoint) missing.push('AI_ENDPOINT');
    else if (!isValidAiEndpoint(aiEndpoint)) invalid.push('AI_ENDPOINT');

    if (!aiApiKey) missing.push('AI_API_KEY');
    else if (/\s/.test(aiApiKey)) invalid.push('AI_API_KEY');

    if (!aiModel) missing.push('AI_MODEL');

    if (aiEndpoint && aiApiKey && aiModel && !invalid.includes('AI_ENDPOINT') && !invalid.includes('AI_API_KEY')) {
      aiConfig = {endpoint: aiEndpoint, apiKey: aiApiKey, model: aiModel};
    }
  }

  // 10. Any caller-specified additional required variables
  if (Array.isArray(options.required)) {
    for (const varName of options.required) {
      if (typeof varName === 'string' && varName) {
        const val = env[varName];
        if (val === undefined || String(val).trim() === '') {
          missing.push(varName);
        }
      }
    }
  }

  if (missing.length > 0) {
    throw new BackendConfigError('CONFIG_MISSING', missing);
  }
  if (invalid.length > 0) {
    throw new BackendConfigError('CONFIG_INVALID', invalid);
  }

  return {
    mode,
    filename,
    host,
    port,
    appOrigin,
    superAdminWallets,
    pinataJwt,
    aiEnabled,
    aiConfig,
    shutdownTimeoutMs,
  };
}

/**
 * Coordinate idempotent graceful shutdown of the HTTP server and SQLite store.
 * Stops accepting new connections, drains in-flight requests up to shutdownTimeoutMs,
 * and closes the SQLite connection once drained.
 */
export function createGracefulShutdown({server, db, shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS, onClose} = {}) {
  let stopping = false;
  let dbClosed = false;
  let donePromise = null;

  function closeDb() {
    if (dbClosed) return;
    dbClosed = true;
    try {
      db.close();
    } catch {
      // ignore repeat close errors
    }
    if (typeof onClose === 'function') onClose();
  }

  function stop() {
    if (stopping) return donePromise;
    stopping = true;
    donePromise = new Promise(resolveStop => {
      const idleTimer = setInterval(() => {
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      }, 25);
      idleTimer.unref();

      const forceTimer = setTimeout(() => {
        clearInterval(idleTimer);
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        closeDb();
        resolveStop();
      }, shutdownTimeoutMs);
      forceTimer.unref();

      server.close(() => {
        clearInterval(idleTimer);
        clearTimeout(forceTimer);
        closeDb();
        resolveStop();
      });
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
    });
    return donePromise;
  }

  return {
    stop,
    isStopping: () => stopping,
    isDbClosed: () => dbClosed,
  };
}
