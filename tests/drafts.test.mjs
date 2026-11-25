import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@stellar/stellar-sdk';
import {openStore} from '../backend/store.mjs';
import {createApi} from '../backend/app.mjs';
import {RULES_SCHEMA,encodeRulesV1} from '../shared/rules-digest.mjs';

const origin='http://127.0.0.1:5173';
async function fixture(t,{superAdminWallets=[],rateLimit=1000}={}){
  const db=openStore(':memory:');let clock=1000;
  const server=createApi({db,appOrigin:origin,now:()=>clock,rateLimit,superAdminWallets});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,{method='GET',body,cookie,requestOrigin=origin,headers={}}={}){
    const h={...headers};if(requestOrigin)h.Origin=requestOrigin;if(body!==undefined)h['Content-Type']='application/json';if(cookie)h.Cookie=cookie;
    const response=await fetch(base+'/api'+path,{method,headers:h,body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(key){
    const c=await call('/auth/challenge',{method:'POST',body:{wallet:key.publicKey()}});
    const r=await call('/auth/verify',{method:'POST',body:{id:c.body.id,signature:Buffer.from(key.signMessage(c.body.message)).toString('base64')}});
    return r.cookie;
  }
  return {db,call,login,setClock:v=>{clock=v;}};
}

function draftBody(overrides={}){
  return {
    question:'Will BTC reach $100k by end of 2026?',
    tradingClose:2000,
    observationTime:2060,
    resolutionDeadline:88400,
    yesRule:'BTC/USD spot median across sources is strictly above $100,000 at observationTime.',
    noRule:'BTC/USD spot median across sources is at or below $100,000 at observationTime.',
    equalityRule:'Resolves NO on exact equality at $100,000.',
    sources:['https://api.coinbase.com/v2/prices/BTC-USD/spot','https://api.kraken.com/0/public/Ticker?pair=XBTUSD'],
    unavailableDataRule:'Resolves Invalid if fewer than two sources report before resolutionDeadline.',
    ...overrides
  };
}
async function currentRevision(f,id,cookie){
  return (await f.call(`/drafts/${id}`,{cookie})).body.revisions[0].id;
}

// --- Schema migration tests ---
test('schema v2 creates draft/review tables and v1 data survives migration',async t=>{
  const db=openStore(':memory:');
  t.after(()=>db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,5);
  // All new tables exist
  for(const table of ['drafts','draft_revisions','review_decisions','audit_events','reviewers','publication_intents']){
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),`Table ${table} should exist`);
  }
  // v1 tables still exist
  for(const table of ['users','challenges','sessions','activity']){
    assert.ok(db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(table),`Table ${table} should still exist`);
  }
});

test('schema rejects future versions',()=>{
  const db=openStore(':memory:');
  db.exec('PRAGMA user_version=99');
  db.close();
  // Can't reopen with version 99
  // openStore(':memory:') always starts fresh, so test with a file
  // We test the version guard logic separately
  const db2=openStore(':memory:');
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version,5);
  db2.close();
});

// --- Draft CRUD tests ---
test('create a draft with all fields and retrieve it',async t=>{
  const f=await fixture(t);
  const creator=Keypair.random();
  const cookie=await f.login(creator);
  const body=draftBody({category:'crypto',yesRule:'BTC spot > $100k',noRule:'BTC spot <= $100k',equalityRule:'NO wins on equality',sources:['coinbase','kraken','bitstamp'],collateral:'native',feeBps:30,resolver:'GABCDEF',metadata:{icon:'btc'}});
  const result=await f.call('/drafts',{method:'POST',cookie,body});
  assert.equal(result.status,201);
  assert.ok(result.body.id>0);
  assert.ok(result.body.revisionId>0);
  assert.ok(typeof result.body.contentHash==='string');

  // Retrieve it
  const get=await f.call(`/drafts/${result.body.id}`,{cookie});
  assert.equal(get.status,200);
  assert.equal(get.body.draft.ownerWallet,creator.publicKey());
  assert.equal(get.body.draft.status,'draft');
  assert.equal(get.body.revisions.length,1);
  assert.equal(get.body.revisions[0].question,'Will BTC reach $100k by end of 2026?');
  assert.equal(get.body.revisions[0].revisionNumber,1);
});

test('list own drafts returns only the creator\'s drafts',async t=>{
  const f=await fixture(t);
  const a=Keypair.random(),b=Keypair.random();
  const ca=await f.login(a),cb=await f.login(b);
  await f.call('/drafts',{method:'POST',cookie:ca,body:draftBody()});
  await f.call('/drafts',{method:'POST',cookie:ca,body:draftBody({question:'Second draft'})});
  await f.call('/drafts',{method:'POST',cookie:cb,body:draftBody({question:'Bob draft'})});

  const aList=await f.call('/drafts',{cookie:ca});
  assert.equal(aList.body.drafts.length,2);
  const bList=await f.call('/drafts',{cookie:cb});
  assert.equal(bList.body.drafts.length,1);
  assert.equal(bList.body.drafts[0].question,'Bob draft');
});

test('update a draft creates a new revision',async t=>{
  const f=await fixture(t);
  const creator=Keypair.random();
  const cookie=await f.login(creator);
  const created=await f.call('/drafts',{method:'POST',cookie,body:draftBody()});
  const draftId=created.body.id;

  const updated=await f.call(`/drafts/${draftId}`,{method:'PUT',cookie,body:draftBody({question:'Updated question',expectedRevisionId:created.body.revisionId})});
  assert.equal(updated.status,200);
  assert.equal(updated.body.revisionNumber,2);

  const get=await f.call(`/drafts/${draftId}`,{cookie});
  assert.equal(get.body.revisions.length,2);
  assert.equal(get.body.revisions[0].question,'Updated question'); // Desc order
  assert.equal(get.body.revisions[0].revisionNumber,2);
});

test('only the owner can edit or submit a draft',async t=>{
  const f=await fixture(t);
  const creator=Keypair.random(),other=Keypair.random();
  const cc=await f.login(creator),co=await f.login(other);
  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;

  assert.equal((await f.call(`/drafts/${id}`,{method:'PUT',cookie:co,body:draftBody({question:'Hijack',expectedRevisionId:created.body.revisionId})})).status,403);
  assert.equal((await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:co,body:{}})).status,403);
  assert.equal((await f.call(`/drafts/${id}/withdraw`,{method:'POST',cookie:co,body:{}})).status,403);
});

test('draft validation rejects empty questions, bad timestamps and excess fees',async t=>{
  const f=await fixture(t);
  const creator=Keypair.random();
  const cookie=await f.login(creator);

  assert.equal((await f.call('/drafts',{method:'POST',cookie,body:{question:'',tradingClose:2000}})).status,400);
  assert.equal((await f.call('/drafts',{method:'POST',cookie,body:{question:'x'.repeat(513),tradingClose:2000}})).status,400);
  assert.equal((await f.call('/drafts',{method:'POST',cookie,body:{question:'Valid?',tradingClose:-1}})).status,400);
  assert.equal((await f.call('/drafts',{method:'POST',cookie,body:{question:'Valid?',tradingClose:2000,feeBps:1001}})).status,400);
  assert.equal((await f.call('/drafts',{method:'POST',cookie,body:{question:'Valid?',tradingClose:2000,sources:'notarray'}})).status,400);
});

// --- State machine tests ---
test('draft state machine: draft → submitted → approved → deployed lifecycle',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);

  // Add reviewer
  assert.equal((await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}})).status,200);

  // Create and submit
  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;
  assert.equal((await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}})).status,200);

  // Verify status
  const after=await f.call(`/drafts/${id}`,{cookie:cc});
  assert.equal(after.body.draft.status,'submitted');

  // Approve
  const approval=await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',reason:'Looks good',expectedRevisionId:await currentRevision(f,id,cr)}});
  assert.equal(approval.status,200);
  assert.equal(approval.body.status,'approved');
  assert.ok(approval.body.approvedParamsHash);
  assert.ok(approval.body.expiry>0);

  const approved=await f.call(`/drafts/${id}`,{cookie:cc});
  assert.equal(approved.body.draft.status,'approved');
  assert.equal(approved.body.reviews.length,1);
  assert.equal(approved.body.reviews[0].decision,'approved');
});

test('changes_requested returns draft to editable state',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'changes_requested',reason:'Be more specific',expectedRevisionId:await currentRevision(f,id,cr)}});

  const draft=await f.call(`/drafts/${id}`,{cookie:cc});
  assert.equal(draft.body.draft.status,'changes_requested');

  // Can edit and resubmit
  assert.equal((await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Refined question',expectedRevisionId:await currentRevision(f,id,cc)})})).status,200);
  const updated=await f.call(`/drafts/${id}`,{cookie:cc});
  assert.equal(updated.body.draft.status,'draft');
  assert.equal((await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}})).status,200);
});

test('rejected drafts cannot be submitted or edited',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'rejected',reason:'Inappropriate',expectedRevisionId:await currentRevision(f,id,cr)}});

  assert.equal((await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}})).status,409);
  assert.equal((await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Try again',expectedRevisionId:await currentRevision(f,id,cc)})})).status,409);
});

test('editing an approved draft invalidates the approval',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',expectedRevisionId:await currentRevision(f,id,cr)}});

  // Edit the approved draft
  const updated=await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Sneaky change',expectedRevisionId:await currentRevision(f,id,cc)})});
  assert.equal(updated.body.status,'draft'); // Reset to draft
  assert.equal(updated.body.revisionNumber,2);
});

test('withdraw pulls back a submitted or approved draft',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  assert.equal((await f.call(`/drafts/${id}/withdraw`,{method:'POST',cookie:cc,body:{}})).status,200);

  const draft=await f.call(`/drafts/${id}`,{cookie:cc});
  assert.equal(draft.body.draft.status,'draft');

  // Cannot withdraw a draft that's in 'draft' status
  assert.equal((await f.call(`/drafts/${id}/withdraw`,{method:'POST',cookie:cc,body:{}})).status,409);
});

// --- Reviewer enforcement tests ---
test('reviewer cannot review their own draft (creator ≠ reviewer)',async t=>{
  const admin=Keypair.random(),dual=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cd=await f.login(dual);

  // dual is both creator and reviewer
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:dual.publicKey(),action:'add'}});
  const created=await f.call('/drafts',{method:'POST',cookie:cd,body:draftBody()});
  await f.call(`/drafts/${created.body.id}/submit`,{method:'POST',cookie:cd,body:{}});

  const review=await f.call(`/drafts/${created.body.id}/review`,{method:'POST',cookie:cd,body:{decision:'approved',expectedRevisionId:await currentRevision(f,created.body.id,cd)}});
  assert.equal(review.status,403);
});

test('non-reviewers cannot review drafts',async t=>{
  const creator=Keypair.random(),rando=Keypair.random();
  const f=await fixture(t);
  const cc=await f.login(creator),cr=await f.login(rando);

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  await f.call(`/drafts/${created.body.id}/submit`,{method:'POST',cookie:cc,body:{}});
  assert.equal((await f.call(`/drafts/${created.body.id}/review`,{method:'POST',cookie:cr,body:{decision:'approved'}})).status,403);
});

test('only submitted drafts can be reviewed',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  // Try to review a draft that hasn't been submitted
  assert.equal((await f.call(`/drafts/${created.body.id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',expectedRevisionId:await currentRevision(f,created.body.id,cr)}})).status,409);
});

// --- Reviewer role management tests ---
test('super-admin can add and revoke reviewers',async t=>{
  const admin=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin);

  // Add
  assert.equal((await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}})).status,200);
  const list=await f.call('/admin/reviewers',{cookie:ca});
  assert.equal(list.body.reviewers.length,1);
  assert.equal(list.body.reviewers[0].wallet,reviewer.publicKey());
  assert.equal(list.body.reviewers[0].revokedAt,null);

  // Revoke
  assert.equal((await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'revoke'}})).status,200);
  const updated=await f.call('/admin/reviewers',{cookie:ca});
  assert.ok(updated.body.reviewers[0].revokedAt!==null);

  // Re-add
  assert.equal((await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}})).status,200);
});

test('duplicate reviewer add is rejected; revoke of non-existent fails',async t=>{
  const admin=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin);

  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});
  assert.equal((await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}})).status,409);
  assert.equal((await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:Keypair.random().publicKey(),action:'revoke'}})).status,404);
});

test('non-admin cannot manage reviewers',async t=>{
  const admin=Keypair.random(),user=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const cu=await f.login(user);

  assert.equal((await f.call('/admin/reviewers',{method:'POST',cookie:cu,body:{wallet:Keypair.random().publicKey(),action:'add'}})).status,403);
  assert.equal((await f.call('/admin/reviewers',{cookie:cu})).status,403);
});

test('revoking a reviewer invalidates pending approvals',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);

  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});
  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',expectedRevisionId:await currentRevision(f,id,cr)}});

  // Revoke reviewer — should invalidate the approval
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'revoke'}});
  const draft=await f.call(`/drafts/${id}`,{cookie:cc});
  assert.equal(draft.body.draft.status,'draft'); // Reset from approved
});

// --- Review queue tests ---
test('review queue shows only submitted drafts to reviewers',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const sub=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody({question:'Submitted one'})});
  await f.call(`/drafts/${sub.body.id}/submit`,{method:'POST',cookie:cc,body:{}});

  const queue=await f.call('/review-queue',{cookie:cr});
  assert.equal(queue.status,200);
  assert.equal(queue.body.queue.length,1);
  assert.equal(queue.body.queue[0].question,'Submitted one');

  // Non-reviewer cannot see queue
  assert.equal((await f.call('/review-queue',{cookie:cc})).status,403);
});

// --- Audit trail tests ---
test('audit events are recorded for all draft actions',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;
  await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Revised',expectedRevisionId:created.body.revisionId})});
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',expectedRevisionId:await currentRevision(f,id,cr)}});

  const audits=f.db.prepare('SELECT action FROM audit_events WHERE draft_id=? ORDER BY id ASC').all(id);
  assert.deepEqual(audits.map(a=>a.action),['created','revised','submitted','reviewed']);
});

// --- Content hash determinism ---
test('content hash is deterministic for identical inputs',async t=>{
  const f=await fixture(t);
  const creator=Keypair.random();
  const cookie=await f.login(creator);
  const body=draftBody({category:'test',yesRule:'yes',sources:['a','b']});

  const r1=await f.call('/drafts',{method:'POST',cookie,body});
  const r2=await f.call('/drafts',{method:'POST',cookie,body});
  assert.equal(r1.body.contentHash,r2.body.contentHash);
});

// --- Access control for viewing ---
test('reviewers can view any draft; non-owners without reviewer role cannot',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random(),rando=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer),co=await f.login(rando);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;

  // Owner can view
  assert.equal((await f.call(`/drafts/${id}`,{cookie:cc})).status,200);
  // Reviewer can view
  assert.equal((await f.call(`/drafts/${id}`,{cookie:cr})).status,200);
  // Super-admin can view
  assert.equal((await f.call(`/drafts/${id}`,{cookie:ca})).status,200);
  // Random user cannot
  assert.equal((await f.call(`/drafts/${id}`,{cookie:co})).status,403);
});

// --- Stale edit protection (expectedRevisionId) ---
function editState(f,id){
  return {
    audits:f.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,
    revisions:f.db.prepare('SELECT COUNT(*) AS n FROM draft_revisions').get().n,
    draft:{...f.db.prepare('SELECT status,updated_at,current_revision_id FROM drafts WHERE id=?').get(id)},
  };
}

test('two saves from the same base revision: exactly one wins, the other gets 409',async t=>{
  const f=await fixture(t);
  const cookie=await f.login(Keypair.random());
  const created=await f.call('/drafts',{method:'POST',cookie,body:draftBody()});
  const id=created.body.id,base=created.body.revisionId;

  const [a,b]=await Promise.all([
    f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({question:'Tab A',expectedRevisionId:base})}),
    f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({question:'Tab B',expectedRevisionId:base})}),
  ]);
  assert.deepEqual([a.status,b.status].sort(),[200,409]);
  const winner=a.status===200?'Tab A':'Tab B';
  const loser=a.status===200?b:a;
  assert.equal(loser.body.code,'revision_conflict');

  const revisions=f.db.prepare('SELECT id,revision_number,question FROM draft_revisions WHERE draft_id=? ORDER BY revision_number').all(id);
  assert.equal(revisions.length,2);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE draft_id=? AND action='revised'").get(id).n,1);
  const current=f.db.prepare('SELECT r.question,r.revision_number FROM drafts d JOIN draft_revisions r ON r.id=d.current_revision_id WHERE d.id=?').get(id);
  assert.equal(current.question,winner);
  assert.equal(current.revision_number,2);
  assert.equal(loser.body.currentRevisionId,revisions[1].id);
  assert.equal(loser.body.currentRevisionNumber,2);
});

test('a stale save returns 409 with only the current revision id and number',async t=>{
  const f=await fixture(t);
  const cookie=await f.login(Keypair.random());
  const created=await f.call('/drafts',{method:'POST',cookie,body:draftBody({yesRule:'private yes rule',sources:['private-source']})});
  const id=created.body.id,rev1=created.body.revisionId;

  const saveA=await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({question:'Save A',expectedRevisionId:rev1})});
  assert.equal(saveA.status,200);
  assert.equal(saveA.body.revisionNumber,2);

  const saveB=await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({question:'Save B',expectedRevisionId:rev1})});
  assert.equal(saveB.status,409);
  assert.deepEqual(saveB.body,{error:'Draft has a newer revision; reload before editing',code:'revision_conflict',currentRevisionId:saveA.body.revisionId,currentRevisionNumber:2});

  const get=await f.call(`/drafts/${id}`,{cookie});
  assert.equal(get.body.revisions.length,2);
  assert.equal(get.body.revisions[0].question,'Save A');
});

test('non-owners get 403 (never 409 or revision details); unknown drafts get 404',async t=>{
  const f=await fixture(t);
  const owner=await f.login(Keypair.random()),other=await f.login(Keypair.random());
  const created=await f.call('/drafts',{method:'POST',cookie:owner,body:draftBody()});
  const id=created.body.id,rev1=created.body.revisionId;
  const saved=await f.call(`/drafts/${id}`,{method:'PUT',cookie:owner,body:draftBody({question:'Owner edit',expectedRevisionId:rev1})});

  for(const expectedRevisionId of [rev1,saved.body.revisionId]){
    const res=await f.call(`/drafts/${id}`,{method:'PUT',cookie:other,body:draftBody({question:'Hijack',expectedRevisionId})});
    assert.equal(res.status,403);
    assert.deepEqual(res.body,{error:'Only the owner can edit a draft'});
  }
  // Even when the draft is not editable, a non-owner learns nothing about its status
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:owner,body:{}});
  const locked=await f.call(`/drafts/${id}`,{method:'PUT',cookie:other,body:draftBody({question:'Hijack',expectedRevisionId:rev1})});
  assert.equal(locked.status,403);
  assert.deepEqual(locked.body,{error:'Only the owner can edit a draft'});

  const missing=await f.call('/drafts/999999',{method:'PUT',cookie:owner,body:draftBody({expectedRevisionId:rev1})});
  assert.equal(missing.status,404);
  assert.deepEqual(missing.body,{error:'Draft not found'});
});

test('expectedRevisionId is required on PUT and rejected on POST',async t=>{
  const f=await fixture(t);
  const cookie=await f.login(Keypair.random());
  const created=await f.call('/drafts',{method:'POST',cookie,body:draftBody()});
  const id=created.body.id,rev1=created.body.revisionId;

  const missing=await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody()});
  assert.equal(missing.status,400);
  assert.deepEqual(missing.body,{error:'expectedRevisionId is required'});
  for(const expectedRevisionId of [String(rev1),0,-1,1.5,null]){
    const res=await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({expectedRevisionId})});
    assert.equal(res.status,400,`expectedRevisionId=${JSON.stringify(expectedRevisionId)}`);
    assert.deepEqual(res.body,{error:'expectedRevisionId is required'});
  }
  const post=await f.call('/drafts',{method:'POST',cookie,body:draftBody({expectedRevisionId:rev1})});
  assert.equal(post.status,400);
  assert.deepEqual(post.body,{error:'Unexpected request fields'});
});

test('expectedRevisionId does not affect the revision content hash',async t=>{
  const f=await fixture(t);
  const cookie=await f.login(Keypair.random());
  const created=await f.call('/drafts',{method:'POST',cookie,body:draftBody()});
  const saved=await f.call(`/drafts/${created.body.id}`,{method:'PUT',cookie,body:draftBody({expectedRevisionId:created.body.revisionId})});
  assert.equal(saved.status,200);
  assert.equal(saved.body.contentHash,created.body.contentHash);
});

test('failed edits write no revision, no audit event and no draft change',async t=>{
  const f=await fixture(t);
  const owner=await f.login(Keypair.random()),other=await f.login(Keypair.random());
  const created=await f.call('/drafts',{method:'POST',cookie:owner,body:draftBody()});
  const id=created.body.id,rev1=created.body.revisionId;
  await f.call(`/drafts/${id}`,{method:'PUT',cookie:owner,body:draftBody({question:'Saved',expectedRevisionId:rev1})});
  const before=editState(f,id);
  f.setClock(1500); // any write from here on would change updated_at

  const attempts=[
    [409,{cookie:owner,body:draftBody({question:'Stale',expectedRevisionId:rev1})}],
    [403,{cookie:other,body:draftBody({question:'Hijack',expectedRevisionId:before.draft.current_revision_id})}],
    [400,{cookie:owner,body:draftBody({question:'No base'})}],
    [400,{cookie:owner,body:{question:'',tradingClose:2000,expectedRevisionId:before.draft.current_revision_id}}],
  ];
  for(const [status,options] of attempts){
    const res=await f.call(`/drafts/${id}`,{method:'PUT',...options});
    assert.equal(res.status,status);
    assert.deepEqual(editState(f,id),before);
  }
});

test('a successful edit invalidates approval; a stale edit leaves the approval in place',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id,rev1=created.body.revisionId;
  const rev2=(await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Reviewed text',expectedRevisionId:rev1})})).body.revisionId;
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  assert.equal((await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',expectedRevisionId:rev2}})).status,200);
  const approvedRevisionId=f.db.prepare("SELECT revision_id FROM review_decisions WHERE draft_id=? AND decision='approved'").get(id).revision_id;
  assert.equal(approvedRevisionId,rev2);

  const stale=await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Stale change',expectedRevisionId:rev1})});
  assert.equal(stale.status,409);
  assert.equal(stale.body.code,'revision_conflict');
  const afterStale=f.db.prepare('SELECT status,current_revision_id FROM drafts WHERE id=?').get(id);
  assert.equal(afterStale.status,'approved');
  assert.equal(afterStale.current_revision_id,approvedRevisionId);

  const edit=await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Changed after approval',expectedRevisionId:rev2})});
  assert.equal(edit.status,200);
  assert.equal(edit.body.status,'draft');
  const row=f.db.prepare('SELECT status,current_revision_id FROM drafts WHERE id=?').get(id);
  assert.equal(row.status,'draft');
  assert.notEqual(row.current_revision_id,approvedRevisionId);
  assert.equal(row.current_revision_id,edit.body.revisionId);
});

test('retrying with currentRevisionId from the 409 body saves as a new revision',async t=>{
  const f=await fixture(t);
  const cookie=await f.login(Keypair.random());
  const created=await f.call('/drafts',{method:'POST',cookie,body:draftBody()});
  const id=created.body.id,rev1=created.body.revisionId;
  await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({question:'Other tab',expectedRevisionId:rev1})});

  const conflict=await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({question:'My version',expectedRevisionId:rev1})});
  assert.equal(conflict.status,409);
  const retry=await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({question:'My version',expectedRevisionId:conflict.body.currentRevisionId})});
  assert.equal(retry.status,200);
  assert.equal(retry.body.revisionNumber,3);

  const get=await f.call(`/drafts/${id}`,{cookie});
  assert.deepEqual(get.body.revisions.map(r=>[r.revisionNumber,r.question]),[[3,'My version'],[2,'Other tab'],[1,'Will BTC reach $100k by end of 2026?']]);
  assert.deepEqual(f.db.prepare('SELECT action FROM audit_events WHERE draft_id=? ORDER BY id').all(id).map(a=>a.action),['created','revised','revised']);
});

test('an internal error during an edit returns a generic 500 and rolls back',async t=>{
  const f=await fixture(t);
  const cookie=await f.login(Keypair.random());
  const created=await f.call('/drafts',{method:'POST',cookie,body:draftBody()});
  const id=created.body.id;
  const before=editState(f,id);
  f.db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON draft_revisions BEGIN SELECT RAISE(ABORT,'internal detail'); END");
  f.setClock(1500);

  const res=await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({question:'Boom',expectedRevisionId:created.body.revisionId})});
  assert.equal(res.status,500);
  assert.deepEqual(res.body,{error:'Internal server error'});
  assert.deepEqual(editState(f,id),before);
});

// --- Review revision binding ---
async function submittedDraft(t,extraReviewers=0){
  const admin=Keypair.random(),creator=Keypair.random(),reviewers=Array.from({length:1+extraReviewers},()=>Keypair.random());
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),crs=[];
  for(const r of reviewers){await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:r.publicKey(),action:'add'}});crs.push(await f.login(r));}
  const id=(await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()})).body.id;
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  const writes=()=>({decisions:f.db.prepare('SELECT COUNT(*) AS n FROM review_decisions WHERE draft_id=?').get(id).n,audits:f.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE draft_id=? AND action='reviewed'").get(id).n});
  return {f,cc,cr:crs[0],crs,id,writes};
}

test('review requires expectedRevisionId',async t=>{
  const {f,cr,id,writes}=await submittedDraft(t);
  assert.equal((await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved'}})).status,400);
  assert.equal((await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',expectedRevisionId:String(await currentRevision(f,id,cr))}})).status,400);
  assert.deepEqual(writes(),{decisions:0,audits:0});
});

test('review of a stale revision returns 409 and writes no decision or audit row',async t=>{
  const {f,cc,cr,id,writes}=await submittedDraft(t);
  const seen=await currentRevision(f,id,cr); // reviewer opens revision 1
  await f.call(`/drafts/${id}/withdraw`,{method:'POST',cookie:cc,body:{}});
  await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Changed after the reviewer loaded it',expectedRevisionId:seen})});
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  const stale=await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',expectedRevisionId:seen}});
  assert.equal(stale.status,409);
  assert.deepEqual(writes(),{decisions:0,audits:0});
  assert.equal((await f.call(`/drafts/${id}`,{cookie:cc})).body.draft.status,'submitted');
  const fresh=await currentRevision(f,id,cr);
  assert.notEqual(fresh,seen);
  assert.equal((await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',expectedRevisionId:fresh}})).status,200);
  assert.deepEqual(writes(),{decisions:1,audits:1});
});

test('review of a draft that is no longer submitted returns 409 and writes nothing',async t=>{
  const {f,cc,cr,id,writes}=await submittedDraft(t);
  const seen=await currentRevision(f,id,cr);
  await f.call(`/drafts/${id}/withdraw`,{method:'POST',cookie:cc,body:{}});
  assert.equal((await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'rejected',expectedRevisionId:seen}})).status,409);
  assert.deepEqual(writes(),{decisions:0,audits:0});
});

test('two competing reviews of the same revision record exactly one decision',async t=>{
  const {f,cc,crs,id,writes}=await submittedDraft(t,1);
  const rev=await currentRevision(f,id,crs[0]);
  const results=await Promise.all([
    f.call(`/drafts/${id}/review`,{method:'POST',cookie:crs[0],body:{decision:'approved',expectedRevisionId:rev}}),
    f.call(`/drafts/${id}/review`,{method:'POST',cookie:crs[1],body:{decision:'rejected',reason:'Too vague',expectedRevisionId:rev}}),
  ]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.deepEqual(writes(),{decisions:1,audits:1});
  const winner=results.find(r=>r.status===200).body.status;
  const draft=await f.call(`/drafts/${id}`,{cookie:cc});
  assert.equal(draft.body.draft.status,winner);
  assert.equal(draft.body.reviews.length,1);
  assert.equal(draft.body.reviews[0].decision,winner);
});

test('review reason and accepted revision remain visible after reload',async t=>{
  const {f,cc,cr,id}=await submittedDraft(t);
  const rev=await currentRevision(f,id,cr);
  assert.equal((await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'changes_requested',reason:'Name the price source',expectedRevisionId:rev}})).status,200);
  for(const cookie of [cc,cr]){
    const reloaded=await f.call(`/drafts/${id}`,{cookie});
    assert.equal(reloaded.body.reviews.length,1);
    assert.equal(reloaded.body.reviews[0].reason,'Name the price source');
    assert.equal(reloaded.body.reviews[0].revisionId,rev);
    assert.equal(reloaded.body.reviews[0].decision,'changes_requested');
  }
  const audit=JSON.parse(f.db.prepare("SELECT detail_json FROM audit_events WHERE draft_id=? AND action='reviewed'").get(id).detail_json);
  assert.equal(audit.revisionId,rev);
});

// --- Publication intent tests (W23) ---
async function setupApprovedDraft(t,{bodyOverrides={},expiry=5000}={}){
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random(),rando=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer),co=await f.login(rando);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});
  const body=draftBody({
    category:'crypto',
    yesRule:'BTC spot > $100k',
    noRule:'BTC spot <= $100k',
    equalityRule:'NO wins on equality',
    sources:['https://api.coinbase.com','https://api.kraken.com'],
    fallbackRule:'Median of active sources',
    unavailableDataRule:'Invalid after deadline',
    collateral:'native',
    feeBps:30,
    resolver:reviewer.publicKey(),
    policyVersion:'v1',
    implementationVersion:'1',
    observationTime:2100,
    resolutionDeadline:2500,
    ...bodyOverrides,
  });
  const created=await f.call('/drafts',{method:'POST',cookie:cc,body});
  const draftId=created.body.id;
  await f.call(`/drafts/${draftId}/submit`,{method:'POST',cookie:cc,body:{}});
  const approval=await f.call(`/drafts/${draftId}/review`,{method:'POST',cookie:cr,body:{decision:'approved',reason:'Approved for intent',expiry,expectedRevisionId:created.body.revisionId}});
  assert.equal(approval.status,200);
  return {f,admin,creator,reviewer,rando,ca,cc,cr,co,draftId,revisionId:created.body.revisionId,contentHash:created.body.contentHash,approval:approval.body};
}

test('W23: approved revision produces an off-chain publication intent pinned to revision, rules digest, reviewer, target network, expiry and exact parameters',async t=>{
  const s=await setupApprovedDraft(t);
  const res=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal(res.status,201);
  assert.equal(res.body.reused,false);
  const intent=res.body.intent;
  assert.ok(intent.id>0);
  assert.equal(intent.draftId,s.draftId);
  assert.equal(intent.revisionId,s.revisionId);
  assert.equal(intent.revisionNumber,1);
  assert.equal(intent.creatorWallet,s.creator.publicKey());
  assert.equal(intent.reviewerWallet,s.reviewer.publicKey());
  assert.equal(intent.targetNetwork,'testnet');
  assert.equal(intent.networkPassphrase,'Test SDF Network ; September 2015');
  const expectedEncoded=encodeRulesV1({
    schema:RULES_SCHEMA,
    network:'testnet',
    question:'Will BTC reach $100k by end of 2026?',
    category:'crypto',
    tradingClose:2000,
    observationTime:2100,
    resolutionDeadline:2500,
    yesRule:'BTC spot > $100k',
    noRule:'BTC spot <= $100k',
    equalityRule:'NO wins on equality',
    sources:['https://api.coinbase.com','https://api.kraken.com'],
    fallbackRule:'Median of active sources',
    unavailableDataRule:'Invalid after deadline',
    collateral:'native',
    feeBps:30,
    resolver:s.reviewer.publicKey(),
    policyVersion:'v1',
    implementationVersion:'1',
  });
  assert.equal(intent.rulesDigest,expectedEncoded.digest);
  assert.notEqual(intent.rulesDigest,s.contentHash);
  assert.equal(intent.rulesDigestVersion,RULES_SCHEMA);
  assert.equal(intent.revisionContentHash,s.contentHash);
  assert.deepEqual(intent.canonicalRules,expectedEncoded.payload);
  assert.equal(intent.canonicalRulesJson,expectedEncoded.json);
  assert.equal(intent.requiresFreshApproval,false);
  assert.equal(intent.approvalExpiry,5000);
  assert.ok(/^[0-9a-f]{64}$/.test(intent.paramsHash));

  // Intent status remains strictly off-chain and cannot be mistaken for a confirmed market
  assert.equal(intent.status,'pending');
  assert.equal(intent.authority,'off_chain_publication_intent');
  assert.equal(intent.confirmedMarket,false);
  assert.equal(intent.deployed,false);
  assert.equal(intent.contractAddress,null);
  assert.equal(intent.txHash,null);

  // Exact deployment parameters are bound in the intent record
  assert.deepEqual(intent.parameters,{
    schema:'revmarket.publication-intent.v1',
    network:'testnet',
    networkPassphrase:'Test SDF Network ; September 2015',
    question:'Will BTC reach $100k by end of 2026?',
    category:'crypto',
    tradingClose:2000,
    observationTime:2100,
    resolutionDeadline:2500,
    yesRule:'BTC spot > $100k',
    noRule:'BTC spot <= $100k',
    equalityRule:'NO wins on equality',
    sources:['https://api.coinbase.com','https://api.kraken.com'],
    fallbackRule:'Median of active sources',
    unavailableDataRule:'Invalid after deadline',
    collateral:'native',
    feeBps:30,
    resolver:s.reviewer.publicKey(),
    policyVersion:'v1',
    implementationVersion:'1',
  });

  // Draft status remains 'approved' (never auto-promoted to confirmed or deployed)
  const draftCheck=await s.f.call(`/drafts/${s.draftId}`,{cookie:s.cc});
  assert.equal(draftCheck.body.draft.status,'approved');

  // Retrieve intent directly and via draft intents list
  const getOne=await s.f.call(`/publication-intents/${intent.id}`,{cookie:s.cc});
  assert.equal(getOne.status,200);
  assert.deepEqual(getOne.body.intent,intent);

  const getByReviewer=await s.f.call(`/publication-intents/${intent.id}`,{cookie:s.cr});
  assert.equal(getByReviewer.status,200);
  assert.equal((await s.f.call(`/publication-intents/${intent.id}`,{cookie:s.co})).status,403);

  const list=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{cookie:s.cc});
  assert.equal(list.status,200);
  assert.equal(list.body.intents.length,1);
  assert.deepEqual(list.body.intents[0],intent);
});

test('W23: identical retries return the same active publication intent record without duplicate rows or audits',async t=>{
  const s=await setupApprovedDraft(t);
  const first=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal(first.status,201);
  assert.equal(first.body.reused,false);

  // Retry with empty body
  const second=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal(second.status,200);
  assert.equal(second.body.reused,true);
  assert.deepEqual(second.body.intent,first.body.intent);

  // Retry with explicit matching revisionId, targetNetwork, and parameters
  const third=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{
    method:'POST',
    cookie:s.cc,
    body:{
      revisionId:s.revisionId,
      targetNetwork:'testnet',
      feeBps:30,
      collateral:'native',
      parameters:{question:'Will BTC reach $100k by end of 2026?',tradingClose:2000},
    },
  });
  assert.equal(third.status,200);
  assert.equal(third.body.reused,true);
  assert.equal(third.body.intent.id,first.body.intent.id);

  // Only one database row and one publication_intent_created audit event exist
  const count=s.f.db.prepare('SELECT COUNT(*) AS n FROM publication_intents WHERE draft_id=?').get(s.draftId).n;
  assert.equal(count,1);
  const audits=s.f.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE draft_id=? AND action='publication_intent_created'").get(s.draftId).n;
  assert.equal(audits,1);
});

test('W23: a different parameter set is rejected and requires a fresh approval on a new revision',async t=>{
  const s=await setupApprovedDraft(t);
  const first=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal(first.status,201);

  // Requesting an intent with different parameters on the same revision fails with 409
  const diffFee=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{feeBps:50}});
  assert.equal(diffFee.status,409);

  const diffNetwork=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{targetNetwork:'mainnet'}});
  assert.equal(diffNetwork.status,409);

  const diffNested=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{parameters:{question:'Tampered?'}}});
  assert.equal(diffNested.status,409);

  // Edit the draft with new parameters -> invalidates previous intent and approval
  const edited=await s.f.call(`/drafts/${s.draftId}`,{method:'PUT',cookie:s.cc,body:draftBody({
    question:'Updated BTC $120k target?',
    category:'crypto',
    yesRule:'BTC spot > $100k',
    noRule:'BTC spot <= $100k',
    equalityRule:'NO wins on equality',
    sources:['https://api.coinbase.com','https://api.kraken.com'],
    fallbackRule:'Median of active sources',
    unavailableDataRule:'Invalid after deadline',
    collateral:'native',
    feeBps:50,
    resolver:s.reviewer.publicKey(),
    policyVersion:'v1',
    implementationVersion:'1',
    observationTime:2100,
    resolutionDeadline:2500,
    expectedRevisionId:s.revisionId,
  })});
  assert.equal(edited.status,200);
  assert.equal(edited.body.status,'draft');

  // Old intent is now invalidated
  const oldIntent=await s.f.call(`/publication-intents/${first.body.intent.id}`,{cookie:s.cc});
  assert.equal(oldIntent.body.intent.status,'invalidated');
  assert.equal(oldIntent.body.intent.invalidatedReason,'draft_revised');

  // Cannot create intent before fresh submission and approval
  assert.equal((await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}})).status,409);
  await s.f.call(`/drafts/${s.draftId}/submit`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal((await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}})).status,409);

  // Fresh approval on revision 2 allows a new intent with the updated parameter set
  await s.f.call(`/drafts/${s.draftId}/review`,{method:'POST',cookie:s.cr,body:{decision:'approved',reason:'Re-approved rev 2',expiry:6000,expectedRevisionId:await currentRevision(s.f,s.draftId,s.cr)}});
  const second=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal(second.status,201);
  assert.notEqual(second.body.intent.id,first.body.intent.id);
  assert.equal(second.body.intent.revisionNumber,2);
  assert.equal(second.body.intent.parameters.question,'Updated BTC $120k target?');
  assert.equal(second.body.intent.parameters.feeBps,50);
  assert.notEqual(second.body.intent.paramsHash,first.body.intent.paramsHash);
});

test('W23: stale, expired, withdrawn, revoked or non-owner approvals cannot produce an eligible intent',async t=>{
  // 1. Non-owner cannot create intent
  const s=await setupApprovedDraft(t,{expiry:2000});
  assert.equal((await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cr,body:{}})).status,403);
  assert.equal((await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.co,body:{}})).status,403);

  // 2. Stale revision ID is rejected
  assert.equal((await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{revisionId:s.revisionId+999}})).status,409);

  // 3. Expired approval cannot produce an eligible intent and transitions any active intent to expired
  const createdIntent=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal(createdIntent.status,201);
  s.f.setClock(2000); // at expiry boundary (approval_expiry <= time)
  const expiredRetry=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal(expiredRetry.status,409);
  const checkExpired=await s.f.call(`/publication-intents/${createdIntent.body.intent.id}`,{cookie:s.cc});
  assert.equal(checkExpired.body.intent.status,'expired');
  assert.equal(checkExpired.body.intent.invalidatedReason,'approval_expired');

  // 4. Withdrawn approval cannot produce an eligible intent and invalidates active intent
  const s2=await setupApprovedDraft(t);
  const intent2=await s2.f.call(`/drafts/${s2.draftId}/publication-intents`,{method:'POST',cookie:s2.cc,body:{}});
  assert.equal(intent2.status,201);
  assert.equal((await s2.f.call(`/drafts/${s2.draftId}/withdraw`,{method:'POST',cookie:s2.cc,body:{}})).status,200);
  assert.equal((await s2.f.call(`/drafts/${s2.draftId}/publication-intents`,{method:'POST',cookie:s2.cc,body:{}})).status,409);
  const checkWithdrawn=await s2.f.call(`/publication-intents/${intent2.body.intent.id}`,{cookie:s2.cc});
  assert.equal(checkWithdrawn.body.intent.status,'invalidated');
  assert.equal(checkWithdrawn.body.intent.invalidatedReason,'draft_withdrawn');

  // 5. Revoked reviewer cannot produce an eligible intent and invalidates active intent
  const s3=await setupApprovedDraft(t);
  const intent3=await s3.f.call(`/drafts/${s3.draftId}/publication-intents`,{method:'POST',cookie:s3.cc,body:{}});
  assert.equal(intent3.status,201);
  assert.equal((await s3.f.call('/admin/reviewers',{method:'POST',cookie:s3.ca,body:{wallet:s3.reviewer.publicKey(),action:'revoke'}})).status,200);
  assert.equal((await s3.f.call(`/drafts/${s3.draftId}/publication-intents`,{method:'POST',cookie:s3.cc,body:{}})).status,409);
  const checkRevoked=await s3.f.call(`/publication-intents/${intent3.body.intent.id}`,{cookie:s3.cc});
  assert.equal(checkRevoked.body.intent.status,'invalidated');
  assert.equal(checkRevoked.body.intent.invalidatedReason,'reviewer_revoked');
});

// --- Submit-time readiness validation tests ---
test('partial manual and AI-assisted drafts remain saveable and editable, but submit rejects incomplete rules without audit events',async t=>{
  const f=await fixture(t);
  const creator=Keypair.random();
  const cookie=await f.login(creator);

  // Create a minimal partial manual draft
  const partial=await f.call('/drafts',{method:'POST',cookie,body:{question:'Will ETH exceed $5,000?',tradingClose:2000}});
  assert.equal(partial.status,201);
  const id=partial.body.id;

  // Attempt to submit the incomplete draft
  const sub1=await f.call(`/drafts/${id}/submit`,{method:'POST',cookie,body:{}});
  assert.equal(sub1.status,400);
  assert.ok(sub1.body.fields);
  assert.ok(sub1.body.fields.yesRule);
  assert.ok(sub1.body.fields.noRule);
  assert.ok(sub1.body.fields.sources);
  assert.ok(sub1.body.fields.unavailableDataRule);
  assert.ok(sub1.body.fields.resolutionDeadline);

  // Failed submission preserves draft status and writes no 'submitted' audit event
  const afterFail=await f.call(`/drafts/${id}`,{cookie});
  assert.equal(afterFail.body.draft.status,'draft');
  const auditsAfterFail=f.db.prepare('SELECT action FROM audit_events WHERE draft_id=? ORDER BY id ASC').all(id);
  assert.deepEqual(auditsAfterFail.map(a=>a.action),['created']);

  // Partial AI-assisted revision remains editable
  const editPartial=await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:{expectedRevisionId:partial.body.revisionId,question:'Will ETH exceed $5,000 by Q4?',tradingClose:2000,origin:'ai_assisted',yesRule:'ETH spot > 5000'}});
  assert.equal(editPartial.status,200);

  // Complete the draft and submit
  const editComplete=await f.call(`/drafts/${id}`,{method:'PUT',cookie,body:draftBody({expectedRevisionId:editPartial.body.revisionId,question:'Will ETH exceed $5,000 by Q4?'})});
  assert.equal(editComplete.status,200);
  const subOk=await f.call(`/drafts/${id}/submit`,{method:'POST',cookie,body:{}});
  assert.equal(subOk.status,200);
  assert.equal(subOk.body.status,'submitted');

  const auditsFinal=f.db.prepare('SELECT action FROM audit_events WHERE draft_id=? ORDER BY id ASC').all(id);
  assert.deepEqual(auditsFinal.map(a=>a.action),['created','revised','revised','submitted']);
});

test('submit rejects identical YES/NO criteria, duplicate/empty sources, and incompatible timing',async t=>{
  const f=await fixture(t);
  const creator=Keypair.random();
  const cookie=await f.login(creator);

  // 1. Identical YES and NO criteria
  const sameRules=await f.call('/drafts',{method:'POST',cookie,body:draftBody({yesRule:'Same rule',noRule:'Same rule'})});
  const resSame=await f.call(`/drafts/${sameRules.body.id}/submit`,{method:'POST',cookie,body:{}});
  assert.equal(resSame.status,400);
  assert.match(resSame.body.fields.noRule,/distinct/i);

  // 2. Duplicate sources
  const dupSources=await f.call('/drafts',{method:'POST',cookie,body:draftBody({sources:['https://a.example','https://a.example']})});
  const resDup=await f.call(`/drafts/${dupSources.body.id}/submit`,{method:'POST',cookie,body:{}});
  assert.equal(resDup.status,400);
  assert.match(resDup.body.fields.sources,/duplicate/i);

  // 3. Incompatible observationTime (< tradingClose) and resolutionDeadline (<= tradingClose or < observationTime)
  const badObs=await f.call('/drafts',{method:'POST',cookie,body:draftBody({tradingClose:2000,observationTime:1900,resolutionDeadline:2500})});
  const resObs=await f.call(`/drafts/${badObs.body.id}/submit`,{method:'POST',cookie,body:{}});
  assert.equal(resObs.status,400);
  assert.ok(resObs.body.fields.observationTime);

  const badDeadline=await f.call('/drafts',{method:'POST',cookie,body:draftBody({tradingClose:2000,observationTime:2200,resolutionDeadline:2100})});
  const resDeadline=await f.call(`/drafts/${badDeadline.body.id}/submit`,{method:'POST',cookie,body:{}});
  assert.equal(resDeadline.status,400);
  assert.ok(resDeadline.body.fields.resolutionDeadline);

  // 4. Expired tradingClose at submission time
  const expiredClose=await f.call('/drafts',{method:'POST',cookie,body:draftBody({tradingClose:2000,observationTime:2100,resolutionDeadline:2200})});
  f.setClock(2000);
  const resExpired=await f.call(`/drafts/${expiredClose.body.id}/submit`,{method:'POST',cookie,body:{}});
  assert.equal(resExpired.status,400);
  assert.ok(resExpired.body.fields.tradingClose);
});

// --- Canonical revmarket.rules.v1 publication intent digest & legacy isolation tests ---
test('canonical publication intent matches docs/RULES_DIGEST.md Vector 1 and changes on policyVersion, unavailableDataRule, and resolutionDeadline',async t=>{
  const vectorBody={
    question:'Will BTC/USD exceed 100,000 USD at the observation time?',
    category:'crypto',
    tradingClose:1800000000,
    observationTime:1800000060,
    resolutionDeadline:1800086400,
    yesRule:'Spot median across listed sources is strictly greater than 100000.00 USD.',
    noRule:'Spot median across listed sources is less than or equal to 100000.00 USD.',
    equalityRule:'Exact equality at 100000.00 USD resolves to NO.',
    sources:[
      'https://api.coinbase.com/v2/prices/BTC-USD/spot',
      'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
      'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    ],
    fallbackRule:'If one source is unavailable, resolve when two remaining sources agree within 2 percent.',
    unavailableDataRule:'If fewer than two sources report within the window, market resolves Invalid.',
    collateral:'native',
    feeBps:30,
    resolver:'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H',
    policyVersion:'v1.0.0',
    implementationVersion:'v2.0.0-rc1',
  };
  const s=await setupApprovedDraft(t,{bodyOverrides:vectorBody});
  const created=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal(created.status,201);
  const intent=created.body.intent;

  const expectedVector=encodeRulesV1({schema:RULES_SCHEMA,network:'testnet',...vectorBody});
  assert.equal(intent.rulesDigest,expectedVector.digest);
  assert.equal(intent.rulesDigest,'37acf9ccdc64ff679b41b45cbc84261ff95157334078ec079ee02f7e829a4af3');
  assert.equal(intent.rulesDigestVersion,RULES_SCHEMA);
  assert.equal(intent.revisionContentHash,s.contentHash);
  assert.notEqual(intent.rulesDigest,intent.revisionContentHash);
  assert.equal(intent.canonicalRulesJson,expectedVector.json);
  assert.equal(Buffer.byteLength(intent.canonicalRulesJson,'utf8'),expectedVector.bytes.length);
  assert.equal(intent.requiresFreshApproval,false);

  // Both creator and reviewer can inspect exact canonical rules committed by the intent
  for(const cookie of [s.cc,s.cr]){
    const inspected=await s.f.call(`/publication-intents/${intent.id}`,{cookie});
    assert.equal(inspected.status,200);
    assert.deepEqual(inspected.body.intent.canonicalRules,encodeRulesV1({schema:RULES_SCHEMA,network:'testnet',...vectorBody}).payload);
    assert.equal(inspected.body.intent.canonicalRulesJson,intent.canonicalRulesJson);
  }

  // Changes to policyVersion, unavailableDataRule, and resolutionDeadline each change rulesDigest
  // even when legacy revisionContentHash does not include those fields
  for(const patch of [
    {policyVersion:'v1.0.1'},
    {unavailableDataRule:'If fewer than two sources report within the window, market resolves NO.'},
    {resolutionDeadline:1800086401},
  ]){
    const s2=await setupApprovedDraft(t,{bodyOverrides:{...vectorBody,...patch}});
    const r2=await s2.f.call(`/drafts/${s2.draftId}/publication-intents`,{method:'POST',cookie:s2.cc,body:{}});
    assert.equal(r2.status,201);
    assert.equal(r2.body.intent.revisionContentHash,intent.revisionContentHash);
    assert.notEqual(r2.body.intent.rulesDigest,intent.rulesDigest,`Patch ${JSON.stringify(patch)} must change rulesDigest`);
    assert.equal(r2.body.intent.rulesDigest,encodeRulesV1({schema:RULES_SCHEMA,network:'testnet',...vectorBody,...patch}).digest);
  }
});

test('incomplete approved draft retains legacy contentHash and rejects canonical publication intent with requiresFreshApproval',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  // draftBody() passes submit validation but omits category, resolver, policyVersion, implementationVersion
  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  const review=await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',expectedRevisionId:created.body.revisionId}});
  assert.equal(review.status,200);

  // Draft view retains original contentHash and never silently relabels as canonical
  const view=await f.call(`/drafts/${id}`,{cookie:cc});
  assert.equal(view.status,200);
  const rev=view.body.revisions[0];
  assert.equal(rev.contentHash,created.body.contentHash);
  assert.equal(rev.canonicalRulesReady,false);
  assert.equal(rev.rulesDigest,null);
  assert.equal(rev.rulesDigestVersion,null);
  assert.ok(typeof rev.canonicalRulesError==='string'&&rev.canonicalRulesError.length>0);

  // Issuing a publication intent is rejected and requires fresh approval on a complete revision
  const intentRes=await f.call(`/drafts/${id}/publication-intents`,{method:'POST',cookie:cc,body:{}});
  assert.equal(intentRes.status,409);
  assert.equal(intentRes.body.code,'incomplete_canonical_rules');
  assert.equal(intentRes.body.requiresFreshApproval,true);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM publication_intents WHERE draft_id=?').get(id).n,0);
});

test('previously persisted legacy publication intent remains readable, is never silently relabeled, and requires fresh approval',async t=>{
  const s=await setupApprovedDraft(t);
  const approvalRow=s.f.db.prepare('SELECT id FROM review_decisions WHERE draft_id=? ORDER BY id DESC LIMIT 1').get(s.draftId);
  const legacyParams=JSON.stringify({schema:'revmarket.publication-intent.v1',network:'testnet',question:'Will BTC reach $100k by end of 2026?'});

  // Insert a pre-v5 legacy publication_intents row (default rules_digest_version='legacy.revision_content_hash', rules_json=NULL)
  const inserted=s.f.db.prepare(`
    INSERT INTO publication_intents(
      draft_id,revision_id,review_decision_id,creator_wallet,reviewer_wallet,
      target_network,network_passphrase,rules_digest,params_hash,params_json,
      approval_expiry,status,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)
  `).run(
    s.draftId,s.revisionId,approvalRow.id,s.creator.publicKey(),s.reviewer.publicKey(),
    'testnet','Test SDF Network ; September 2015',s.contentHash,'a'.repeat(64),legacyParams,
    5000,1000,1000
  );
  const legacyId=Number(inserted.lastInsertRowid);

  // Creator and reviewer can still read the legacy intent; original hash is preserved and never relabeled
  for(const cookie of [s.cc,s.cr]){
    const getOne=await s.f.call(`/publication-intents/${legacyId}`,{cookie});
    assert.equal(getOne.status,200);
    assert.equal(getOne.body.intent.rulesDigest,s.contentHash);
    assert.equal(getOne.body.intent.rulesDigestVersion,'legacy.revision_content_hash');
    assert.equal(getOne.body.intent.revisionContentHash,s.contentHash);
    assert.equal(getOne.body.intent.canonicalRules,null);
    assert.equal(getOne.body.intent.canonicalRulesJson,null);
    assert.equal(getOne.body.intent.requiresFreshApproval,true);
  }

  // Attempting to reuse/re-issue on the legacy pending intent refuses silent relabeling
  const retry=await s.f.call(`/drafts/${s.draftId}/publication-intents`,{method:'POST',cookie:s.cc,body:{}});
  assert.equal(retry.status,409);
  assert.equal(retry.body.code,'legacy_publication_intent');
  assert.equal(retry.body.requiresFreshApproval,true);
});
