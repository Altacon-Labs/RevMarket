import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDraftPayload,
  draftFieldErrors,
  formFromDraftRevision,
  getDraftActionAvailability,
  parseUtcInput,
  parseSources,
  sourcesToTextarea,
  toUtcInput,
  validateDraftSave,
  validateDraftTiming,
} from '../frontend/src/lib/draft-workflow.mjs';

test('UTC inputs round-trip and reject invalid values', () => {
  assert.equal(parseUtcInput('2026-12-01T10:30'), 1796121000);
  assert.equal(toUtcInput(1796121000), '2026-12-01T10:30');
  assert.equal(parseUtcInput(''), null);
  assert.equal(parseUtcInput('12/01/2026'), null);
  assert.equal(parseUtcInput('2026-02-30T10:30'), null);
});

test('timing validation enforces future close, ordering and required deadline', () => {
  const now = 1796000000;
  const valid = {
    tradingClose: now + 3600,
    observationTime: now + 7200,
    resolutionDeadline: now + 10800,
  };
  assert.deepEqual(validateDraftTiming(valid, now), {});

  const invalid = validateDraftTiming({
    tradingClose: now + 3600,
    observationTime: now + 1800,
    resolutionDeadline: now + 60,
  }, now);
  assert.equal(invalid.tradingClose, undefined);
  assert.match(invalid.observationTime, /at or after trading close/);
  assert.match(invalid.resolutionDeadline, /strictly after trading close/);

  const past = validateDraftTiming({tradingClose: now - 60, resolutionDeadline: now + 60}, now);
  assert.match(past.tradingClose, /future/);

  assert.match(validateDraftTiming({tradingClose: now + 3600, resolutionDeadline: null}, now).resolutionDeadline, /required/);
});

test('saving an incomplete draft only requires parseable UTC inputs', () => {
  assert.deepEqual(validateDraftSave({
    tradingClose: '2026-12-01T10:30',
    observationTime: '',
    resolutionDeadline: '',
  }), {});
  assert.match(validateDraftSave({tradingClose: ''}).tradingClose, /valid UTC trading close/);
  assert.match(validateDraftSave({tradingClose: '2026-12-01T10:30', resolutionDeadline: 'bad'}).resolutionDeadline, /valid UTC resolution deadline/);
});

test('backend field errors are surfaced from the wrapped API error body', () => {
  assert.deepEqual(
    draftFieldErrors({body: {fields: {yesRule: 'Required', resolutionDeadline: 'Invalid'}}}),
    {yesRule: 'Required', resolutionDeadline: 'Invalid'},
  );
  assert.deepEqual(draftFieldErrors(new Error('boom')), {});
  assert.deepEqual(draftFieldErrors({body: {fields: ['nope']}}), {});
});

test('action availability matches saved draft status', () => {
  assert.equal(getDraftActionAvailability('draft').canSubmit, true);
  assert.equal(getDraftActionAvailability('draft').canWithdraw, false);
  assert.equal(getDraftActionAvailability('submitted').canSave, false);
  assert.equal(getDraftActionAvailability('submitted').canWithdraw, true);
  assert.equal(getDraftActionAvailability('changes_requested').canSubmit, true);
  assert.equal(getDraftActionAvailability('changes_requested').canWithdraw, false);
  assert.equal(getDraftActionAvailability('rejected').canSubmit, false);
  assert.match(getDraftActionAvailability('submitted').reason, /Withdraw/);
});

test('saved revisions map back into the editable form and payload', () => {
  const form = formFromDraftRevision({
    question: 'Will X happen?',
    category: 'Crypto',
    trading_close: 1796121000,
    observation_time: 1796207400,
    resolution_deadline: 1796293800,
    yes_rule: 'YES if confirmed',
    no_rule: 'NO otherwise',
    sources_json: JSON.stringify(['https://example.com/a', 'https://example.com/b']),
    metadata_json: JSON.stringify({description: 'Context'}),
    unavailable_data_rule: 'Resolve NO',
  });
  assert.equal(form.tradingClose, '2026-12-01T10:30');
  assert.equal(form.sources, 'https://example.com/a\nhttps://example.com/b');
  assert.equal(form.description, 'Context');

  const {payload, timingErrors} = buildDraftPayload(form, {collateral: 100, nowSeconds: 1796000000});
  assert.deepEqual(timingErrors, {});
  assert.equal(payload.tradingClose, 1796121000);
  assert.deepEqual(payload.sources, ['https://example.com/a', 'https://example.com/b']);
  assert.equal(payload.unavailableDataRule, 'Resolve NO');
  assert.equal(payload.collateral, 100);
});

test('GET /api/drafts/:id camelCase revisions restore into the form', () => {
  const form = formFromDraftRevision({
    id: 42,
    revisionNumber: 3,
    question: 'Will Y happen?',
    category: 'Politics',
    tradingClose: 1796121000,
    observationTime: 1796207400,
    resolutionDeadline: 1796293800,
    yesRule: 'YES if verified',
    noRule: 'NO if not',
    equalityRule: 'Use equal split',
    sourcesJson: JSON.stringify(['https://example.com/source']),
    fallbackRule: 'Resolve NO',
    unavailableDataRule: 'Treat as NO',
    metadataJson: JSON.stringify({description: 'Restored context'}),
    policyVersion: 'v2',
  });
  assert.equal(form.tradingClose, '2026-12-01T10:30');
  assert.equal(form.observationTime, '2026-12-02T10:30');
  assert.equal(form.resolutionDeadline, '2026-12-03T10:30');
  assert.equal(form.sources, 'https://example.com/source');
  assert.equal(form.description, 'Restored context');
  assert.equal(form.unavailableDataRule, 'Treat as NO');
  assert.equal(form.policyVersion, 'v2');
});

test('source textarea parsing normalizes blank and duplicate lines', () => {
  assert.deepEqual(parseSources(' https://a.test \n\nhttps://b.test\n'), ['https://a.test', 'https://b.test']);
  assert.equal(sourcesToTextarea(['https://a.test', 42]), 'https://a.test');
});
