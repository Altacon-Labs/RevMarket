// Opt-in public-testnet integration test. Keys exist in memory only and are never printed or saved.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Address,Asset,Keypair,Networks,Operation,TransactionBuilder,scValToNative,rpc} from '@stellar/stellar-sdk';
import {createClient,sc} from '../shared/stellar.mjs';
import {processMarket} from '../service/runner.mjs';
import {digest} from '../service/policy.mjs';
const network=Networks.TESTNET;
const server=new rpc.Server('https://soroban-testnet.stellar.org');
const [operator,alice,bob]=[Keypair.random(),Keypair.random(),Keypair.random()];
const transactions=[];
for(const key of [operator,alice,bob]) {
  const response=await fetch(`https://friendbot.stellar.org?addr=${key.publicKey()}`,{signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error(`Friendbot unavailable: ${response.status}`);
}
const sign=key=>async(xdr,passphrase)=>{const tx=TransactionBuilder.fromXDR(xdr,passphrase);tx.sign(key);return tx.toXDR();};
async function operation(op) {
  const raw=new TransactionBuilder(await server.getAccount(operator.publicKey()),{fee:'10000',networkPassphrase:network}).addOperation(op).setTimeout(120).build();
  const tx=await server.prepareTransaction(raw);
  if(BigInt(tx.fee)>1000000000n)throw Error('Smoke deployment exceeds 100 test XLM fee budget');
  tx.sign(operator);
  const sent=await server.sendTransaction(tx);
  if(sent.status!=='PENDING')throw Error(`Deployment submission: ${sent.status}`);
  for(let i=0;i<60;i++){
    await new Promise(r=>setTimeout(r,1500));
    const result=await server.getTransaction(sent.hash);
    if(result.status==='SUCCESS'){transactions.push({method:'deployment',hash:sent.hash});return scValToNative(result.returnValue);}
    if(result.status==='FAILED')throw Error(`Deployment failed: ${sent.hash}`);
  }
  throw Error(`Deployment timeout: ${sent.hash}`);
}
let wasm;
try { wasm=await readFile(new URL('../contracts/target/wasm32v1-none/release/revmarket.wasm',import.meta.url)); }
catch(e) { if(e.code!=='ENOENT')throw e; wasm=await readFile(new URL('../artifacts/revmarket.wasm',import.meta.url)); }
const wasmHash=await operation(Operation.uploadContractWasm({wasm}));
const token=Asset.native().contractId(network);
const contractId=await operation(Operation.createCustomContract({address:new Address(operator.publicKey()),wasmHash,constructorArgs:[sc.address(token),sc.address(operator.publicKey())]}));
console.log(`Ephemeral testnet contract: ${contractId}`);
const client=createClient({rpcUrl:'https://soroban-testnet.stellar.org',contractId});
const invoke=async(key,method,args)=>{
  const result=await client.write(key.publicKey(),sign(key),method,args);
  transactions.push({method,hash:result.hash});return result;
};
const close=Math.floor(Date.now()/1000)+100;
const question='Integration fixture: deterministic YES (not a real-world event)';
const created=await invoke(alice,'create',[sc.address(alice.publicKey()),sc.text(question),sc.text(''),sc.kind(null,0),sc.u64(close)]);
const id=created.value;
assert.equal(id,0);
await invoke(alice,'predict',[sc.address(alice.publicKey()),sc.u32(id),sc.u32(0),sc.i128(10000000n)]);
await invoke(bob,'predict',[sc.address(bob.publicKey()),sc.u32(id),sc.u32(1),sc.i128(10000000n)]);
await assert.rejects(invoke(alice,'predict',[sc.address(alice.publicKey()),sc.u32(id),sc.u32(1),sc.i128(1n)]));
await assert.rejects(invoke(alice,'request',[sc.u32(id)]));
console.log('Both positions confirmed; waiting for closing time.');
while(Math.floor(Date.now()/1000)<close+6)await new Promise(r=>setTimeout(r,1000));
const evidenceDir=new URL('../docs/smoke-evidence/',import.meta.url);
await mkdir(evidenceDir,{recursive:true});
const workerClient={...client,write:async(source,signer,method,args)=>{
  const r=await client.write(source,signer,method,args);transactions.push({method,hash:r.hash});return r;
}};
const resolved=await processMarket({client:workerClient,source:operator.publicKey(),sign:sign(operator),id,
  providers:{contractId,event:async()=>['fixture-a','fixture-b'].map(source=>({source,marketId:id,questionHash:digest(question),outcome:0,confidence:9000,observedAt:Math.floor(Date.now()/1000),evidenceUrl:'https://example.org/integration-fixture'}))},
  saveEvidence:async(hash,evidence)=>writeFile(new URL(`${hash}.json`,evidenceDir),JSON.stringify(evidence))});
assert.equal(resolved,'settled');
const settled=await client.read(alice.publicKey(),'get_market',[sc.u32(id)]);
assert.equal(settled.status,2);assert.equal(settled.outcome,0);
await assert.rejects(invoke(bob,'claim',[sc.address(bob.publicKey()),sc.u32(id)]));
const paid=await invoke(alice,'claim',[sc.address(alice.publicKey()),sc.u32(id)]);
assert.equal(paid.value,20000000n);
await assert.rejects(invoke(alice,'claim',[sc.address(alice.publicKey()),sc.u32(id)]));
assert.equal((await client.read(alice.publicKey(),'get_position',[sc.u32(id),sc.address(alice.publicKey())])).claimed,true);
const tokenClient=createClient({rpcUrl:'https://soroban-testnet.stellar.org',contractId:token});
assert.equal(await tokenClient.read(operator.publicKey(),'balance',[sc.address(contractId)]),0n);
const report={date:new Date().toISOString(),network:'Stellar Testnet',contractId,token,wasmSha256:createHash('sha256').update(wasm).digest('hex'),resolver:operator.publicKey(),transactions,checks:['actual WASM upload/deployment','actual XLM SAC deposits','duplicate prediction rejected','early request rejected','real worker path with deterministic fixture evidence','settlement confirmed','loser claim rejected','winner paid 2 XLM','duplicate claim rejected','escrow balance zero'],limitations:['ephemeral identities not saved','fixture evidence is not real event resolution','Freighter and live price providers not exercised','testnet deployment may disappear on reset']};
await writeFile(new URL('../docs/TESTNET_SMOKE.json',import.meta.url),JSON.stringify(report,null,2));
console.log('Public-testnet integration passed; report saved to docs/TESTNET_SMOKE.json');
