import test from 'node:test';
import assert from 'node:assert/strict';
import {scValToNative} from '@stellar/stellar-sdk';
import {processMarket} from '../service/runner.mjs';
import {sc} from '../shared/stellar.mjs';
import {digest} from '../service/policy.mjs';
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
