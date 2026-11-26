import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReviewPayload,
  decisionAvailability,
  decisionErrorFeedback,
  formatUtcSeconds,
  latestDecision,
  parseUtcSeconds,
  revisionRuleSummary,
} from '../frontend/src/lib/review-workflow.mjs';

const reviewer = {wallet: 'G_REVIEWER', isActiveReviewer: true, canReviewQueue: true};
const admin = {wallet: 'G_ADMIN', isSuperAdmin: true, canReviewQueue: true};
const draft = {ownerWallet: 'G_CREATOR', status: 'submitted'};

test('review permissions distinguish queue readers from active reviewers', () => {
  assert.equal(decisionAvailability(reviewer, draft).canViewQueue, true);
  assert.equal(decisionAvailability(reviewer, draft).canDecide, true);
  assert.match(decisionAvailability(admin, draft).reason, /only active reviewers can submit decisions/i);
  assert.equal(decisionAvailability(admin, draft).canDecide, false);
  assert.equal(decisionAvailability({...reviewer, wallet: draft.ownerWallet}, draft).canDecide, false);
  assert.equal(decisionAvailability(reviewer, {...draft, status: 'changes_requested'}).canDecide, false);
  assert.match(decisionAvailability(null, draft).reason, /Sign in/);
});

test('review errors give actionable guidance for session, role, revision and decided states', () => {
  assert.match(decisionErrorFeedback({status: 401}), /session expired/i);
  assert.match(decisionErrorFeedback({status: 403, message: 'Active reviewer role required'}), /role is no longer active/i);
  assert.match(decisionErrorFeedback({status: 403, message: 'Reviewers cannot review their own drafts'}), /own draft/i);
  assert.match(decisionErrorFeedback({status: 409, message: 'Draft has a newer revision; reload before reviewing'}), /newer revision/i);
  assert.match(decisionErrorFeedback({status: 409, message: 'Only submitted drafts can be reviewed'}), /already decided or withdrawn/i);
});

test('decision payload pins the exact revision and only sends future approval expiry', () => {
  assert.deepEqual(buildReviewPayload({
    decision: 'changes_requested',
    reason: '  Add a source  ',
    expectedRevisionId: 17,
  }, 1000), {decision: 'changes_requested', reason: 'Add a source', expectedRevisionId: 17});

  assert.deepEqual(buildReviewPayload({
    decision: 'approved',
    reason: 'ok',
    expiryInput: '2026-12-01T10:30',
    expectedRevisionId: 18,
  }, 1000), {decision: 'approved', reason: 'ok', expectedRevisionId: 18, expiry: 1796121000});

  assert.throws(() => buildReviewPayload({decision: 'approved', expiryInput: '2026-12-01T10:30', expectedRevisionId: 18}, 1796121001), /UTC time in the future/);
  assert.throws(() => buildReviewPayload({decision: 'approved', expiryInput: 'bad', expectedRevisionId: 18}), /UTC time in the future/);
  assert.throws(() => buildReviewPayload({decision: 'approved', expiryInput: '2026-12-01T10:30'}), /saved revision/);
});

test('latest decision exposes reason, revision and approval expiry to the creator', () => {
  const decision = latestDecision([{
    decision: 'approved',
    reason: 'Rules are clear',
    revisionId: 9,
    reviewerWallet: 'G_REVIEWER',
    expiry: 1796121000,
  }]);
  assert.equal(decision.decision, 'approved');
  assert.equal(decision.reason, 'Rules are clear');
  assert.equal(decision.revisionId, 9);
  assert.equal(decision.expiryLabel, '2026-12-01 10:30 UTC');
  assert.equal(parseUtcSeconds('2026-02-30T10:30'), null);
  assert.equal(formatUtcSeconds(1796121000), '2026-12-01 10:30 UTC');
});

test('saved revision summary uses the exact stored rules and sources', () => {
  const summary = revisionRuleSummary({
    id: 12,
    revisionNumber: 3,
    question: 'Will X happen?',
    yesRule: 'YES rule',
    noRule: 'NO rule',
    unavailableDataRule: 'Resolve NO',
    sourcesJson: JSON.stringify(['https://a.example', 'https://b.example']),
    tradingClose: 1796121000,
  });
  assert.equal(summary.revisionId, 12);
  assert.deepEqual(summary.sources, ['https://a.example', 'https://b.example']);
  assert.equal(summary.tradingClose, '2026-12-01 10:30 UTC');
  assert.equal(summary.yesRule, 'YES rule');
});
