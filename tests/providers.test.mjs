import test from 'node:test';
import assert from 'node:assert/strict';
import {getJson,priceObservations,eventObservations} from '../service/providers.mjs';
test('price adapters use three USD markets and exact decimal strings',async()=>{
  const urls=[];
  const fake=async(url,opts)=>{
    urls.push(url);assert.equal(opts.redirect,'error');
    const body=url.includes('coinbase')?{data:{amount:'100.00000001'}}:url.includes('kraken')?{result:{pair:{c:['100.01']}}}:{last:'100.02'};
    return {ok:true,text:async()=>JSON.stringify(body)};
  };
  const result=await priceObservations('ETH',fake,()=>200);
  assert.equal(result[0].price,'10000000001');assert.equal(result[0].observedAt,200);
  assert.equal(new Set(result.map(x=>x.source)).size,3);assert.ok(urls.every(x=>!x.includes('USDT')));
  await assert.rejects(priceObservations('BAD',fake));
});
test('event URLs use distinct configured HTTPS hosts; response cannot forge source identity',async()=>{
  const fake=async url=>({ok:true,text:async()=>JSON.stringify({marketId:Number(url.searchParams.get('marketId')),source:'forged'})});
  const results=await eventObservations(['https://a.example/evidence','https://b.example/evidence'],7,fake);
  assert.deepEqual(results.map(x=>x.source),['a.example','b.example']);assert.equal(results[0].marketId,7);
  for(const urls of [['http://a.example','https://b.example'],['https://a.example/one','https://a.example/two'],['https://user:password@a.example','https://b.example']])await assert.rejects(eventObservations(urls,7,fake));
});
test('bad HTTP and oversized provider responses are rejected',async()=>{
  await assert.rejects(getJson('https://example.org',async()=>({ok:false,status:429})));
  await assert.rejects(getJson('https://example.org',async()=>({ok:true,text:async()=>' '.repeat(100001)})));
  await assert.rejects(getJson('https://example.org',async()=>({ok:true,text:async()=>'{broken'})));
});
