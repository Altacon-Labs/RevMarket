import test from 'node:test';
import assert from 'node:assert/strict';
import {scValToNative, Networks} from '@stellar/stellar-sdk';
import {processMarket} from '../service/runner.mjs';
import {sc} from '../shared/stellar.mjs';
import {digest} from '../service/policy.mjs';
import {createAttemptStore} from '../service/attempts.mjs';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pollDueMarkets} from '../service/scheduler.mjs';
function fixture(kind=['Price','ETH',100n]) {
  const m={status:0,closes_at:200n,deadline:86600n,kind,question:'Question'};const writes=[],saved=[];
  return {m,writes,saved,options:{id:4,source:'test',sign:()=>{},now:()=>205,
    client:{read:async()=>({...m}),write:async(s,k,method,args)=>{writes.push({method,args:args.map(scValToNative)});if(method==='request')m.status=1;else m.status=2;}},
    providers:{contractId:'test-contract',price:async()=>[100n,101n,102n].map((p,i)=>({source:`p${i}`,price:(p*100000000n).toString(),observedAt:201})),event:async()=>[0,1].map(i=>({source:`h${i}`,marketId:4,questionHash:digest('Question'),outcome:1,confidence:9000,observedAt:201,evidenceUrl:'https://example.org'}))},saveEvidence:async(hash,evidence)=>saved.push({hash,evidence})}};
}
test('price request → persisted evidence → settlement; rerun skips confirmed market',async()=>{
  const f=fixture();assert.equal(await processMarket(f.options),'settled');
  assert.deepEqual(f.writes.map(x=>x.method),['request','settle_price']);
  assert.equal(f.writes[1].args[1],10100000000n);assert.equal(f.saved[0].hash,digest(f.saved[0].evidence));
  assert.equal(Buffer.from(f.writes[1].args[2]).toString('hex'),f.saved[0].hash);
  assert.equal(await processMarket(f.options),'skipped');assert.equal(f.writes.length,2);
});
test('event submits agreed result; no settlement when providers or persistence fail',async()=>{
  const f=fixture(['Event']);await processMarket(f.options);assert.equal(f.writes[1].method,'settle_event');assert.equal(f.writes[1].args[1],1);
  for(const field of ['provider','storage']){
    const x=fixture();if(field==='provider')x.options.providers.price=async()=>{throw Error('offline');};else x.options.saveEvidence=async()=>{throw Error('disk full');};
    await assert.rejects(processMarket(x.options));assert.deepEqual(x.writes.map(w=>w.method),['request']);
  }
});
test('Soroban wire encoding preserves enum and 128-bit types',()=>{
  assert.deepEqual(scValToNative(sc.kind('ETH',123n)),['Price','ETH',123n]);
  assert.deepEqual(scValToNative(sc.kind(null,0)),['Event']);
  assert.equal(scValToNative(sc.i128(90071992547409931n)),90071992547409931n);
});

test('persisted signed attempt is submitted after restart without changing evidence or sequence',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'revmarket-attempt-'));const store=createAttemptStore(join(dir,'attempts.sqlite'));
  try {
    const f=fixture();let submitted=0;const states=['unknown','confirmed'];
    Object.assign(f.options,{attemptStore:store,client:{...f.options.client,
      prepare:async()=>({hash:'tx-hash',xdr:'signed-xdr',sequence:'42'}),submit:async xdr=>{assert.equal(xdr,'signed-xdr');submitted++;},
      inspect:async()=>({status:states.shift()})}});
    assert.equal(await processMarket(f.options),'unknown');
    const saved=store.get(Networks.TESTNET,'test-contract',4);
    assert.equal(saved.hash,'tx-hash');assert.equal(saved.sequence,'42');assert.equal(saved.evidence_hash,f.saved[0].hash);
    assert.equal(await processMarket(f.options),'settled');assert.equal(submitted,1);
    assert.equal(store.get(Networks.TESTNET,'test-contract',4).status,'confirmed');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('prepared attempts recover before submission and failed or expired attempts remain distinct',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'revmarket-attempt-'));const store=createAttemptStore(join(dir,'attempts.sqlite'));
  try {
    const f=fixture();let submitted=0;let state='pending';
    Object.assign(f.options,{attemptStore:store,client:{...f.options.client,
      prepare:async()=>({hash:'tx-hash',xdr:'signed-xdr',sequence:'9'}),submit:async()=>{submitted++;},
      inspect:async()=>({status:state})}});
    store.begin({network:Networks.TESTNET,contract:'test-contract',market:4,hash:'tx-hash',signedXdr:'signed-xdr',evidenceHash:'evidence',sequence:'9'});
    assert.equal(await processMarket(f.options),'pending');assert.equal(submitted,1);
    state='failed';assert.equal(await processMarket(f.options),'failed');
    assert.equal(store.get(Networks.TESTNET,'test-contract',4).status,'failed');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('retry scheduling uses deterministic bounded backoff and preserves due times across restart',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'revmarket-jobs-'));const path=join(dir,'attempts.sqlite');
  let store=createAttemptStore(path);let now=100;const ran=[];
  try {
    const due=await pollDueMarkets({store,network:'testnet',contract:'c',count:2,now:()=>now,batchSize:2,
      process:async id=>{ran.push(id);if(id===0)throw Error('provider down');return 'settled';}});
    assert.deepEqual(due,[0,1]);assert.deepEqual(ran,[0,1]);
    assert.equal(store.getJob('testnet','c',0).next_attempt_at,105);
    store.close();store=createAttemptStore(path);
    now=104;
    assert.deepEqual(await pollDueMarkets({store,network:'testnet',contract:'c',count:2,now:()=>now,batchSize:2,process:async()=>{throw Error('not due');}}),[]);
    now=105;const retried=[];
    assert.deepEqual(await pollDueMarkets({store,network:'testnet',contract:'c',count:2,now:()=>now,batchSize:2,
      process:async id=>{retried.push(id);return 'settled';}}),[0]);
    assert.deepEqual(retried,[0]);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('retry backoff is capped and jobs expire at their stored deadline',()=>{
  const dir=mkdtempSync(join(tmpdir(),'revmarket-jobs-'));const store=createAttemptStore(join(dir,'attempts.sqlite'));
  try {
    store.ensureJob('testnet','c',8,10);store.setWindow('testnet','c',8,{closesAt:10,deadline:1000,now:10});
    let now=10;
    for(let i=0;i<7;i++){const next=store.defer('testnet','c',8,{now});assert.ok(next-now<=300);now=next;}
    assert.equal(now,625);
    store.ensureJob('testnet','c',9,20);store.setWindow('testnet','c',9,{closesAt:20,deadline:25,now:20});
    assert.equal(store.defer('testnet','c',9,{now:21}),null);
    assert.equal(store.getJob('testnet','c',9).state,'expired');
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});
