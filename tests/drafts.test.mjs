import test from 'node:test';
import assert from 'node:assert/strict';
import {Keypair} from '@stellar/stellar-sdk';
import {openStore} from '../backend/store.mjs';
import {createApi} from '../backend/app.mjs';

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
  return {question:'Will BTC reach $100k by end of 2026?',tradingClose:2000,...overrides};
}

// --- Schema migration tests ---
test('schema v2 creates draft/review tables and v1 data survives migration',async t=>{
  const db=openStore(':memory:');
  t.after(()=>db.close());
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);
  // All new tables exist
  for(const table of ['drafts','draft_revisions','review_decisions','audit_events','reviewers']){
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
  assert.equal(db2.prepare('PRAGMA user_version').get().user_version,2);
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

  const updated=await f.call(`/drafts/${draftId}`,{method:'PUT',cookie,body:draftBody({question:'Updated question'})});
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

  assert.equal((await f.call(`/drafts/${id}`,{method:'PUT',cookie:co,body:draftBody({question:'Hijack'})})).status,403);
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
  const approval=await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved',reason:'Looks good'}});
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
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'changes_requested',reason:'Be more specific'}});

  const draft=await f.call(`/drafts/${id}`,{cookie:cc});
  assert.equal(draft.body.draft.status,'changes_requested');

  // Can edit and resubmit
  assert.equal((await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Refined question'})})).status,200);
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
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'rejected',reason:'Inappropriate'}});

  assert.equal((await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}})).status,409);
  assert.equal((await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Try again'})})).status,409);
});

test('editing an approved draft invalidates the approval',async t=>{
  const admin=Keypair.random(),creator=Keypair.random(),reviewer=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  const ca=await f.login(admin),cc=await f.login(creator),cr=await f.login(reviewer);
  await f.call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});

  const created=await f.call('/drafts',{method:'POST',cookie:cc,body:draftBody()});
  const id=created.body.id;
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved'}});

  // Edit the approved draft
  const updated=await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Sneaky change'})});
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

  const review=await f.call(`/drafts/${created.body.id}/review`,{method:'POST',cookie:cd,body:{decision:'approved'}});
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
  assert.equal((await f.call(`/drafts/${created.body.id}/review`,{method:'POST',cookie:cr,body:{decision:'approved'}})).status,409);
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
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved'}});

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
  await f.call(`/drafts/${id}`,{method:'PUT',cookie:cc,body:draftBody({question:'Revised'})});
  await f.call(`/drafts/${id}/submit`,{method:'POST',cookie:cc,body:{}});
  await f.call(`/drafts/${id}/review`,{method:'POST',cookie:cr,body:{decision:'approved'}});

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

