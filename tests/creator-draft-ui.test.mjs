import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const modal = readFileSync(new URL('../frontend/src/components/CreateMarketModal.jsx', import.meta.url), 'utf8');
const backend = readFileSync(new URL('../frontend/src/lib/backend.mjs', import.meta.url), 'utf8');

test('creator workflow API wrappers target the draft lifecycle endpoints', () => {
  assert.match(backend, /export async function listDrafts/);
  assert.match(backend, /api\('\/drafts'/);
  assert.match(backend, /export async function submitDraft/);
  assert.match(backend, /api\(`\/drafts\/\$\{draftId\}\/submit`/);
  assert.match(backend, /export async function withdrawDraft/);
  assert.match(backend, /api\(`\/drafts\/\$\{draftId\}\/withdraw`/);
});

test('creator modal renders every structured rule required for review', () => {
  for (const label of [
    'YES resolution rule',
    'NO resolution rule',
    'Observation time (UTC)',
    'Resolution deadline (UTC)',
    'Sources',
    'Unavailable-data policy',
    'Review summary',
  ]) {
    assert.ok(modal.includes(label), `missing creator field: ${label}`);
  }
  for (const name of ['yesRule', 'noRule', 'observationTime', 'resolutionDeadline', 'sources', 'unavailableDataRule']) {
    assert.ok(modal.includes(`name="${name}"`), `missing form field binding: ${name}`);
    assert.ok(modal.includes(`<FieldError name="${name}"`), `missing field error for: ${name}`);
  }
});

test('creator modal exposes status-aware submit, withdraw and resubmit actions', () => {
  assert.match(modal, /getDraftActionAvailability\(savedDraft\?\.status\)/);
  assert.match(modal, /Submit for review/);
  assert.match(modal, /Save & resubmit/);
  assert.match(modal, /Withdraw proposal/);
  assert.match(modal, /draftAvailability\.canSave/);
  assert.match(modal, /draftAvailability\.canSubmit/);
  assert.match(modal, /draftAvailability\.canWithdraw/);
  assert.match(modal, /draftAvailability\.reason/);
  assert.match(modal, /Reviewed submissions are saved off-chain first/);
});

test('creator modal saves then submits the exact stored revision', () => {
  assert.match(modal, /const next = await persistDraft\(\);/);
  assert.match(modal, /await submitDraft\(next\.draftId\)/);
  assert.match(modal, /expectedRevisionId: savedDraft\.revisionId/);
  assert.match(modal, /getDraft\(next\.draftId\)/);
  assert.match(modal, /formFromDraftRevision\(revision\)/);
  assert.match(modal, /draftFieldErrors\(err\)/);
  assert.match(modal, /validateDraftSave\(draftValues\)/);
  assert.match(modal, /validateDraftTiming\(\{/);
});

test('saved proposals can be reopened with their server-reported status', () => {
  assert.match(modal, /listDrafts\(\)/);
  assert.match(modal, /openSavedDraft\(selectedDraftId\)/);
  assert.match(modal, /status: result\.draft\.status/);
  assert.match(modal, /revisionNumber: revision\.revisionNumber/);
});

test('the last opened proposal is restored after a page reload', () => {
  assert.match(modal, /LAST_DRAFT_KEY/);
  assert.match(modal, /readLastDraftId/);
  assert.match(modal, /rememberDraftId/);
  assert.match(modal, /localStorage\.getItem\(LAST_DRAFT_KEY\)/);
  assert.match(modal, /lastId && rows\.some/);
});
