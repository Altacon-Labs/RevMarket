import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const script = fileURLToPath(new URL('../scripts/staging-drill.mjs', import.meta.url));
const faults = new URL('./fixtures/staging-drill-faults.mjs', import.meta.url).href;

test('staging drill reports setup, workflow, termination, and cleanup failures', {concurrency: 3}, async t => {
  const cases = [
    {name: 'setup', phase: 'setup', message: /injected temporary setup failure/},
    {name: 'put', check: 'manualDraftingWithAiDisabled', message: /revision update failed \(HTTP 400\)/},
    {name: 'ai-revision', check: 'wiredAiAssistWorksWhenConfigured', message: /revision mismatch: expected \d+, got \d+/},
    {name: 'ai-confidence', check: 'wiredAiAssistWorksWhenConfigured', message: /confidence mismatch: expected high, got "low"/},
    {name: 'spawn-error', check: 'readinessExposedToHost', message: /spawn .* ENOENT/},
    {name: 'startup-timeout', check: 'readinessExposedToHost', message: /did not become ready/, signal: 'SIGTERM'},
    {name: 'shutdown-timeout', check: 'restartPreservesDraftsAndSessions', message: /graceful shutdown timed out/, signal: 'null'},
    {name: 'ignore-sigterm', check: 'restartPreservesDraftsAndSessions', message: /graceful shutdown timed out/, signal: 'SIGKILL'},
    {name: 'cleanup', phase: 'cleanup', message: /injected temporary cleanup failure/, cleanup: true},
    {name: 'put-and-cleanup', check: 'manualDraftingWithAiDisabled', message: /revision update failed \(HTTP 400\)/, cleanup: true},
    {name: 'unconfirmed-exit', check: 'manualDraftingWithAiDisabled', message: /revision update failed \(HTTP 400\)/,
      cleanupError: /could not confirm staging backend termination for PID \d+ after SIGKILL/},
  ];

  await Promise.all(cases.map(scenario => t.test(scenario.name, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'staging-drill-test-'));
    t.after(() => rm(dir, {recursive: true, force: true}));
    const started = performance.now();
    const {error, stdout, stderr} = await new Promise(resolve => {
      execFile(process.execPath, ['--experimental-sqlite', script], {
        env: {...process.env, TMPDIR: dir, NODE_OPTIONS: `--import=${faults}`, STAGING_DRILL_TEST_FAULT: scenario.name},
        timeout: 30_000,
      }, (error, stdout, stderr) => resolve({error, stdout, stderr}));
    });
    const elapsed = Math.round(performance.now() - started);
    const children = [...stderr.matchAll(/test backend spawned (\d+)/g)].map(match => Number(match[1]));
    for (const pid of children) assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
    assert.equal(error?.code, 1, stderr);
    const report = JSON.parse(stdout);
    assert.equal(report.outcome, 'failed');
    assert.equal(report.failure.phase, scenario.phase ?? 'workflow');
    assert.match(report.failure.message, scenario.message);
    assert.match(stderr, scenario.message);
    if (scenario.cleanupError) {
      assert.equal(report.cleanupErrors.length, 1);
      assert.match(report.cleanupErrors[0], scenario.cleanupError);
      assert.equal(children.length, 1);
      assert.equal((await readdir(dir)).length, 1);
    } else {
      assert.deepEqual(report.cleanupErrors, scenario.cleanup ? ['injected temporary cleanup failure'] : []);
    }
    if (scenario.check) assert.equal(report.checkResults[scenario.check], 'failed');
    if (/put/.test(scenario.name)) {
      assert.equal(report.checkResults.aiDisabledReturns503, 'passed');
      assert.equal(report.checkResults.restartPreservesDraftsAndSessions, 'skipped');
    }
    if (scenario.name === 'setup') assert.ok(Object.values(report.checkResults).every(status => status === 'skipped'));
    if (scenario.name === 'cleanup') {
      assert.ok(Object.values(report.checkResults).every(status => status === 'passed'));
      assert.equal(report.checks.rollbackRestoresExactSnapshot, true);
    }
    if (scenario.signal) {
      assert.equal(children.length, 1);
      const exit = stderr.match(new RegExp(`test backend exited ${children[0]} (\\S+) ${scenario.signal} (\\d+)ms`));
      assert.ok(exit, stderr);
      if (scenario.name === 'shutdown-timeout') assert.equal(exit[1], '0');
      if (scenario.name === 'ignore-sigterm') assert.ok(Number(exit[2]) >= 7_000);
      t.diagnostic(`PID ${children[0]} gone, child exit after ${exit[2]}ms, drill exit after ${elapsed}ms`);
    }
    if (!scenario.cleanup && !scenario.cleanupError) assert.deepEqual(await readdir(dir), []);
  })));
});
