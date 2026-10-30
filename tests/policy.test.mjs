import test from 'node:test';
import assert from 'node:assert/strict';
import {resolvePrice,resolveEvent,digest} from '../service/policy.mjs';
import {parseAmount,formatAmount,priceUnits} from '../shared/amount.mjs';
const prices=()=>['10000000000','10100000000','10050000000'].map((price,i)=>({source:`source${i}`,price,observedAt:200}));
test('median preserves integer precision and rejects weak, stale and divergent evidence',()=>{
  assert.equal(resolvePrice(prices(),200,205),10050000000n);
  for(const x of [prices().slice(1),prices().map(x=>({...x,source:'same'})),prices().map(x=>({...x,observedAt:100})),prices().map((x,i)=>({...x,price:i===0?'20000000000':x.price})),prices().map(x=>({...x,price:'NaN'}))]) assert.throws(()=>resolvePrice(x,200,205));
  assert.throws(()=>resolvePrice(prices(),200,291)); assert.throws(()=>resolvePrice(prices(),200,199));
});
const event=()=>[0,1].map(i=>({source:`host${i}`,marketId:4,questionHash:digest('Question'),outcome:0,confidence:9000,observedAt:200,evidenceUrl:'https://example.org/proof'}));
const context={id:4,question:'Question',closesAt:200,now:205};
test('event requires matching market, evidence, timestamps and unanimous sources',()=>{
  assert.deepEqual(resolveEvent(event(),context),{outcome:0,confidence:9000});
  for(const change of [{outcome:1},{confidence:7999},{questionHash:'wrong'},{marketId:5},{observedAt:0},{observedAt:999},{evidenceUrl:'http://unsafe'},{source:'host0'}]){
    const rows=event(); rows[1]={...rows[1],...change}; assert.throws(()=>resolveEvent(rows,context));
  }
  assert.throws(()=>resolveEvent(event().slice(1),context));
});
test('amount codecs avoid floating point and reject ambiguous inputs',()=>{
  assert.equal(parseAmount('9007199254.7409931'),90071992547409931n);
  assert.equal(formatAmount(90071992547409931n),'9007199254.7409931');
  assert.equal(priceUnits('123.12345678'),12312345678n);
  for(const x of ['0','-1','1e3','NaN','1.12345678','01',' 1'])assert.throws(()=>parseAmount(x));
});
