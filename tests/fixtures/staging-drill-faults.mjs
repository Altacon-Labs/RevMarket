// Preloaded only by the staging drill regression tests.
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {basename, dirname, join} from 'node:path';

const scenario = process.env.STAGING_DRILL_TEST_FAULT;
const entry = process.argv[1] ?? '';

if (entry.endsWith('/backend/server.mjs')) {
  if (scenario === 'startup-timeout' && process.connected) {
    // Keep the actual child alive without opening a listener.
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
  if (['shutdown-timeout', 'ignore-sigterm'].includes(scenario)) {
    const emit = process.emit;
    process.emit = function (event, ...args) {
      if (event === 'message' && args[0] === 'shutdown') return true;
      if (event === 'SIGTERM' && scenario === 'ignore-sigterm') return true;
      return emit.call(this, event, ...args);
    };
  }
}

if (entry.endsWith('/scripts/staging-drill.mjs')) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (file, args, options) => {
    const ipc = options.stdio.includes('ipc');
    if (ipc && scenario === 'spawn-error') file = join(process.env.TMPDIR, 'missing-node');
    const child = spawn(file, args, {
      ...options,
      env: {...options.env, STAGING_DRILL_TEST_FAULT: scenario},
    });
    if (ipc && child.pid) {
      if (scenario === 'unconfirmed-exit') {
        const emit = child.emit;
        child.emit = function (event, ...args) {
          if (event === 'close') return true;
          return emit.call(this, event, ...args);
        };
      }
      const pid = child.pid;
      const started = Date.now();
      console.error(`test backend spawned ${pid}`);
      child.once('exit', (code, signal) => {
        console.error(`test backend exited ${pid} ${code} ${signal} ${Date.now() - started}ms`);
      });
      if (scenario === 'startup-timeout') {
        // Advance the startup clock after giving the real child time to launch.
        const now = performance.now.bind(performance);
        const startup = now();
        Object.defineProperty(performance, 'now', {
          value: () => now() + (now() - startup > 800 ? 45_000 : 0),
        });
      }
    }
    return child;
  };

  if (scenario === 'setup') {
    fs.mkdtemp = async () => { throw new Error('injected temporary setup failure'); };
  }
  if (['cleanup', 'put-and-cleanup'].includes(scenario)) {
    const rm = fs.rm;
    fs.rm = async (path, options) => {
      if (dirname(String(path)) === process.env.TMPDIR && basename(String(path)).startsWith('revmarket-staging-drill-')) {
        throw new Error('injected temporary cleanup failure');
      }
      return rm(path, options);
    };
  }
  syncBuiltinESMExports();

  const request = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (options?.method === 'PUT' && /^\/api\/drafts\/\d+$/.test(path) &&
        ['put', 'put-and-cleanup', 'unconfirmed-exit'].includes(scenario)) {
      return Response.json({}, {status: 400});
    }
    const response = await request(url, options);
    if (response.ok && path.endsWith('/ai-assist') && ['ai-revision', 'ai-confidence'].includes(scenario)) {
      const body = await response.json();
      if (scenario === 'ai-revision') body.sourceRevision.revisionId += 1;
      else body.suggestions.confidence = 'low';
      return Response.json(body);
    }
    return response;
  };
}
