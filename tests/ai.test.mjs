import test from 'node:test';
import assert from 'node:assert/strict';
import {sanitizeInput, buildPrompt, validateResponse} from '../backend/ai.mjs';

// --- sanitizeInput tests ---
test('sanitizeInput extracts and truncates valid fields',()=>{
  const result=sanitizeInput({question:'Will BTC hit $100k?',category:'crypto',yesRule:'Price > $100k',noRule:'Price <= $100k',sources:['coinbase','kraken']});
  assert.equal(result.question,'Will BTC hit $100k?');
  assert.equal(result.category,'crypto');
  assert.equal(result.yesRule,'Price > $100k');
  assert.deepEqual(result.sources,['coinbase','kraken']);
});

test('sanitizeInput handles missing/invalid fields gracefully',()=>{
  const result=sanitizeInput({question:123,sources:'not-array'});
  assert.equal(result.question,'');
  assert.deepEqual(result.sources,[]);
});

test('sanitizeInput truncates long strings',()=>{
  const result=sanitizeInput({question:'x'.repeat(600)});
  assert.equal(result.question.length,512);
});

test('sanitizeInput caps sources at 10',()=>{
  const sources=Array.from({length:15},(_,i)=>`source${i}`);
  assert.equal(sanitizeInput({question:'Q',sources}).sources.length,10);
});

test('sanitizeInput rejects null/undefined/non-object',()=>{
  assert.throws(()=>sanitizeInput(null));
  assert.throws(()=>sanitizeInput(undefined));
  assert.throws(()=>sanitizeInput('string'));
});

// --- buildPrompt tests ---
test('buildPrompt includes question and rules',()=>{
  const prompt=buildPrompt({question:'Will it rain?',category:'weather',yesRule:'Rain observed',noRule:'No rain',sources:['weather.gov']});
  assert.ok(prompt.includes('Will it rain?'));
  assert.ok(prompt.includes('Rain observed'));
  assert.ok(prompt.includes('weather.gov'));
  assert.ok(prompt.includes('NEVER'));
  assert.ok(prompt.includes('valid JSON'));
});

test('buildPrompt handles empty sources',()=>{
  const prompt=buildPrompt({question:'Q',category:'',yesRule:'',noRule:'',sources:[]});
  assert.ok(prompt.includes('none specified'));
});

// --- validateResponse tests ---
test('validateResponse parses valid JSON response',()=>{
  const response=JSON.stringify({
    suggestedQuestion:'Will Bitcoin exceed $100,000 USD by December 31, 2026?',
    suggestedYesRule:'BTC/USD spot price > $100,000 on any major exchange',
    suggestedNoRule:'BTC/USD spot price <= $100,000',
    suggestedSources:['CoinGecko','CoinMarketCap','Kraken'],
    ambiguityFlags:['Specify exact time zone for the deadline'],
    duplicateCandidates:[],
    unresolved:['Which exchanges count as major?'],
    confidence:'high',
  });
  const result=validateResponse(response);
  assert.equal(result.suggestedQuestion,'Will Bitcoin exceed $100,000 USD by December 31, 2026?');
  assert.equal(result.confidence,'high');
  assert.equal(result.suggestedSources.length,3);
  assert.equal(result.ambiguityFlags.length,1);
  assert.equal(result.unresolved.length,1);
});

test('validateResponse handles markdown-fenced JSON',()=>{
  const response='Here is my analysis:\n```json\n{"suggestedQuestion":"Better question?","confidence":"medium"}\n```\nHope that helps!';
  const result=validateResponse(response);
  assert.equal(result.suggestedQuestion,'Better question?');
  assert.equal(result.confidence,'medium');
});

test('validateResponse rejects non-JSON',()=>{
  assert.throws(()=>validateResponse('This is just text'));
});

test('validateResponse rejects oversized responses',()=>{
  assert.throws(()=>validateResponse('x'.repeat(16385)));
});

test('validateResponse defaults missing fields safely',()=>{
  const result=validateResponse('{}');
  assert.equal(result.suggestedQuestion,null);
  assert.equal(result.suggestedYesRule,null);
  assert.deepEqual(result.suggestedSources,[]);
  assert.deepEqual(result.ambiguityFlags,[]);
  assert.equal(result.confidence,'low');
});

test('validateResponse truncates oversized arrays and strings',()=>{
  const response=JSON.stringify({
    suggestedSources:Array.from({length:20},(_,i)=>`source${i}`),
    ambiguityFlags:Array.from({length:20},(_,i)=>`flag${i}`),
    suggestedQuestion:'x'.repeat(600),
    confidence:'invalid',
  });
  const result=validateResponse(response);
  assert.equal(result.suggestedSources.length,10);
  assert.equal(result.ambiguityFlags.length,10);
  assert.equal(result.suggestedQuestion,null); // Exceeds 512 limit
  assert.equal(result.confidence,'low'); // Invalid falls back to low
});

test('validateResponse filters non-string array entries',()=>{
  const response=JSON.stringify({suggestedSources:['valid',123,null,{obj:true},'also valid']});
  const result=validateResponse(response);
  assert.deepEqual(result.suggestedSources,['valid','also valid']);
});

// --- AI endpoint integration test ---
test('AI assist endpoint returns suggestions and records audit',async t=>{
  // We test via the API with a mock AI function
  const {openStore}=await import('../backend/store.mjs');
  const {createApi}=await import('../backend/app.mjs');
  const {Keypair}=await import('@stellar/stellar-sdk');
  const origin='http://127.0.0.1:5173';
  const db=openStore(':memory:');let clock=1000;
  const mockSuggestions={suggestedQuestion:'Refined question?',suggestedSources:['source1'],ambiguityFlags:['Be more specific'],duplicateCandidates:[],unresolved:[],confidence:'medium',model:'test-model',inputHash:'abc123'};
  const server=createApi({db,appOrigin:origin,now:()=>clock,getAiSuggestionsFn:async()=>mockSuggestions});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,opts={}){
    const h={Origin:origin,...opts.headers};if(opts.body!==undefined)h['Content-Type']='application/json';if(opts.cookie)h.Cookie=opts.cookie;
    const r=await fetch(base+'/api'+path,{method:opts.method||'GET',headers:h,body:opts.body===undefined?undefined:JSON.stringify(opts.body)});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(key){const c=await call('/auth/challenge',{method:'POST',body:{wallet:key.publicKey()}});return(await call('/auth/verify',{method:'POST',body:{id:c.body.id,signature:Buffer.from(key.signMessage(c.body.message)).toString('base64')}})).cookie;}
  const creator=Keypair.random();
  const cookie=await login(creator);
  const created=await call('/drafts',{method:'POST',cookie,body:{question:'Will BTC reach $100k?',tradingClose:2000}});
  assert.equal(created.status,201);
  const result=await call(`/drafts/${created.body.id}/ai-assist`,{method:'POST',cookie,body:{}});
  assert.equal(result.status,200);
  assert.equal(result.body.suggestions.suggestedQuestion,'Refined question?');
  assert.equal(result.body.suggestions.confidence,'medium');
  // Verify audit trail
  const audit=db.prepare('SELECT action FROM audit_events WHERE draft_id=? ORDER BY id DESC LIMIT 1').get(created.body.id);
  assert.equal(audit.action,'ai_assisted');
  // Verify origin updated
  const draft=db.prepare('SELECT origin FROM drafts WHERE id=?').get(created.body.id);
  assert.equal(draft.origin,'ai_assisted');
});

test('AI assist rejects non-owner and non-editable drafts',async t=>{
  const {openStore}=await import('../backend/store.mjs');
  const {createApi}=await import('../backend/app.mjs');
  const {Keypair}=await import('@stellar/stellar-sdk');
  const origin='http://127.0.0.1:5173';
  const db=openStore(':memory:');let clock=1000;
  const admin=Keypair.random();
  const server=createApi({db,appOrigin:origin,now:()=>clock,superAdminWallets:[admin.publicKey()],getAiSuggestionsFn:async()=>({})});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,opts={}){
    const h={Origin:origin,...opts.headers};if(opts.body!==undefined)h['Content-Type']='application/json';if(opts.cookie)h.Cookie=opts.cookie;
    const r=await fetch(base+'/api'+path,{method:opts.method||'GET',headers:h,body:opts.body===undefined?undefined:JSON.stringify(opts.body)});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(key){const c=await call('/auth/challenge',{method:'POST',body:{wallet:key.publicKey()}});return(await call('/auth/verify',{method:'POST',body:{id:c.body.id,signature:Buffer.from(key.signMessage(c.body.message)).toString('base64')}})).cookie;}
  const creator=Keypair.random(),other=Keypair.random(),reviewer=Keypair.random();
  const cc=await login(creator),co=await login(other),cr=await login(reviewer),ca=await login(admin);
  await call('/admin/reviewers',{method:'POST',cookie:ca,body:{wallet:reviewer.publicKey(),action:'add'}});
  const created=await call('/drafts',{method:'POST',cookie:cc,body:{question:'Q?',tradingClose:2000}});
  // Non-owner cannot request AI
  assert.equal((await call(`/drafts/${created.body.id}/ai-assist`,{method:'POST',cookie:co,body:{}})).status,403);
  // Submit to make it non-editable
  await call(`/drafts/${created.body.id}/submit`,{method:'POST',cookie:cc,body:{}});
  assert.equal((await call(`/drafts/${created.body.id}/ai-assist`,{method:'POST',cookie:cc,body:{}})).status,409);
});

test('AI assist returns 503 when not configured',async t=>{
  const {openStore}=await import('../backend/store.mjs');
  const {createApi}=await import('../backend/app.mjs');
  const {Keypair}=await import('@stellar/stellar-sdk');
  const origin='http://127.0.0.1:5173';
  const db=openStore(':memory:');let clock=1000;
  const server=createApi({db,appOrigin:origin,now:()=>clock});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,opts={}){
    const h={Origin:origin,...opts.headers};if(opts.body!==undefined)h['Content-Type']='application/json';if(opts.cookie)h.Cookie=opts.cookie;
    const r=await fetch(base+'/api'+path,{method:opts.method||'GET',headers:h,body:opts.body===undefined?undefined:JSON.stringify(opts.body)});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(key){const c=await call('/auth/challenge',{method:'POST',body:{wallet:key.publicKey()}});return(await call('/auth/verify',{method:'POST',body:{id:c.body.id,signature:Buffer.from(key.signMessage(c.body.message)).toString('base64')}})).cookie;}
  const creator=Keypair.random();
  const cookie=await login(creator);
  const created=await call('/drafts',{method:'POST',cookie,body:{question:'Q?',tradingClose:2000}});
  assert.equal((await call(`/drafts/${created.body.id}/ai-assist`,{method:'POST',cookie,body:{}})).status,503);
});
