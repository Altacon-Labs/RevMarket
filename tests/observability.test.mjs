import test from 'node:test';
import assert from 'node:assert/strict';
import {writeStructuredLog} from '../shared/observability.mjs';

test('structured log fields exclude wallet signatures, session cookies, prompts and resolver secrets',()=>{
  const lines=[];
  writeStructuredLog('info',{service:'revmarket-worker',event:'worker_attempt_started',correlationId:'attempt-1',reasonCode:'worker_attempt_started',marketId:4,attempt:2,walletSignature:'sig-secret',sessionCookie:'cookie-secret',prompt:'prompt-secret',resolverSecret:'resolver-secret'},line=>lines.push(line));
  assert.equal(lines.length,1);
  assert.match(lines[0],/"correlationId":"attempt-1"/);
  for(const secret of ['sig-secret','cookie-secret','prompt-secret','resolver-secret'])assert.equal(lines[0].includes(secret),false);
});
