import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keypair} from '@stellar/stellar-sdk';
import {openStore} from '../backend/store.mjs';
import {createApi} from '../backend/app.mjs';

const origin='http://127.0.0.1:5173';
async function fixture(t,{rateLimit=1000,superAdminWallets=[],uploadImage}={}){
  const db=openStore(':memory:');let clock=1000;
  const server=createApi({db,appOrigin:origin,now:()=>clock,rateLimit,superAdminWallets,uploadImage});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});db.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function call(path,{method='GET',body,form,cookie,requestOrigin=origin,headers={}}={}){
    const h={...headers};if(requestOrigin)h.Origin=requestOrigin;if(body!==undefined)h['Content-Type']='application/json';if(cookie)h.Cookie=cookie;
    const response=await fetch(base+'/api'+path,{method,headers:h,body:form|| (body===undefined?undefined:JSON.stringify(body))});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],cookieHeader:response.headers.get('set-cookie')};
  }
  async function challenge(key){const r=await call('/auth/challenge',{method:'POST',body:{wallet:key.publicKey()}});assert.equal(r.status,200);return r.body;}
  async function login(key){const c=await challenge(key);const r=await call('/auth/verify',{method:'POST',body:{id:c.id,signature:Buffer.from(key.signMessage(c.message)).toString('base64')}});assert.equal(r.status,200);return r.cookie;}
  return {db,server,call,challenge,login,setClock:value=>{clock=value;}};
}

test('backend health and request boundaries reject missing origins, malformed wallets and oversized bodies',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('/health')).body.automationEnabled,false);
  assert.equal((await f.call('/me')).status,401);
  assert.equal((await f.call('/auth/challenge',{method:'POST',body:{wallet:Keypair.random().publicKey()},requestOrigin:null})).status,403);
  assert.equal((await f.call('/auth/challenge',{method:'POST',body:{wallet:'bad'},requestOrigin:'https://wrong.example'})).status,403);
  assert.equal((await f.call('/auth/challenge',{method:'POST',body:{wallet:'bad'}})).status,400);
  assert.equal((await f.call('/auth/challenge',{method:'POST',body:{wallet:'x'.repeat(9000)}})).status,413);
  assert.equal((await f.call('/automation/enable',{method:'POST',body:{}})).status,404);
});
test('SEP-53 sign-in creates only a public-key profile and hashed HttpOnly session',async t=>{
  const f=await fixture(t),key=Keypair.random(),c=await f.challenge(key);
  assert.ok(c.message.includes('Origin: '+origin));assert.ok(c.message.includes('No transaction or automation authority'));
  const result=await f.call('/auth/verify',{method:'POST',body:{id:c.id,signature:Buffer.from(key.signMessage(c.message)).toString('base64')}});
  assert.equal(result.status,200);assert.match(result.cookieHeader,/HttpOnly/);assert.match(result.cookieHeader,/SameSite=Strict/);
  const me=await f.call('/me',{cookie:result.cookie});assert.equal(me.body.wallet,key.publicKey());assert.equal(me.body.automationEnabled,false);
  const stored=f.db.prepare('SELECT token_hash FROM sessions').get().token_hash;
  assert.notEqual(stored,result.cookie.split('=')[1]);
});
test('wrong-key and raw signatures fail; a consumed challenge cannot replay',async t=>{
  const f=await fixture(t),key=Keypair.random(),other=Keypair.random();
  const c=await f.challenge(key),signature=Buffer.from(other.signMessage(c.message)).toString('base64');
  assert.equal((await f.call('/auth/verify',{method:'POST',body:{id:c.id,signature}})).status,401);
  assert.equal((await f.call('/auth/verify',{method:'POST',body:{id:c.id,signature:Buffer.from(key.signMessage(c.message)).toString('base64')}})).status,401);
  const raw=await f.challenge(key);
  assert.equal((await f.call('/auth/verify',{method:'POST',body:{id:raw.id,signature:Buffer.from(key.sign(Buffer.from(raw.message))).toString('base64')}})).status,401);
  const good=await f.challenge(key),body={id:good.id,signature:Buffer.from(key.signMessage(good.message)).toString('base64')};
  assert.equal((await f.call('/auth/verify',{method:'POST',body})).status,200);
  assert.equal((await f.call('/auth/verify',{method:'POST',body})).status,401);
});
test('expiry boundaries invalidate challenges and sessions',async t=>{
  const f=await fixture(t),key=Keypair.random(),c=await f.challenge(key);
  f.setClock(c.expiresAt);
  assert.equal((await f.call('/auth/verify',{method:'POST',body:{id:c.id,signature:Buffer.from(key.signMessage(c.message)).toString('base64')}})).status,401);
  f.setClock(2000);const cookie=await f.login(key);f.setClock(5600);
  assert.equal((await f.call('/me',{cookie})).status,401);
});
test('activity is scoped, deduplicated and explicitly unverified',async t=>{
  const f=await fixture(t),a=Keypair.random(),b=Keypair.random(),alice=await f.login(a),bob=await f.login(b);
  const body={wallet:a.publicKey(),action:'predict',txHash:'a'.repeat(64)};
  assert.equal((await f.call('/activity',{method:'POST',cookie:alice,body})).status,200);
  assert.equal((await f.call('/activity',{method:'POST',cookie:alice,body})).status,200);
  assert.equal((await f.call('/activity',{method:'POST',cookie:bob,body})).status,403);
  const rows=(await f.call('/activity',{cookie:alice})).body.items;
  assert.equal(rows.length,1);assert.equal(rows[0].verification,'unverified_client_report');
  assert.equal((await f.call('/activity',{cookie:bob})).body.items.length,0);
  assert.equal((await f.call('/activity',{method:'POST',cookie:alice,body:{...body,extra:'not accepted'}})).status,400);
  assert.equal((await f.call('/users')).status,404);
});
test('super-admin network status requires a signed allowlisted wallet',async t=>{
  const admin=Keypair.random(),member=Keypair.random();
  const f=await fixture(t,{superAdminWallets:[admin.publicKey()]});
  assert.equal((await f.call('/admin/network')).status,401);
  const adminCookie=await f.login(admin),memberCookie=await f.login(member);
  const result=await f.call('/admin/network',{cookie:adminCookie});
  assert.equal(result.status,200);
  assert.equal(result.body.role,'super_admin');
  assert.equal(result.body.networks.testnet.available,true);
  assert.equal(result.body.networks.mainnet.available,false);
  assert.equal((await f.call('/admin/network',{cookie:memberCookie})).status,403);
});
test('market image upload requires the matching signed wallet and returns a pinned CID',async t=>{
  const key=Keypair.random(),cid='bafybeihgxdzljxb26q6nf3r3eifqeedsvt2eubqtskghpme66cgjyw4fra';
  let uploaded=null;
  const f=await fixture(t,{uploadImage:async image=>{uploaded={type:image.type,size:image.bytes.length};return cid;}});
  const createForm=()=>{const form=new FormData();form.append('image',new Blob([Buffer.from([137,80,78,71,13,10,26,10,1,2,3])],{type:'image/png'}),'market.png');return form;};
  assert.equal((await f.call('/market-image',{method:'POST',form:createForm()})).status,401);
  const cookie=await f.login(key);
  assert.equal((await f.call('/market-image',{method:'POST',cookie,headers:{'X-Stellar-Wallet':Keypair.random().publicKey()},form:createForm()})).status,403);
  const result=await f.call('/market-image',{method:'POST',cookie,headers:{'X-Stellar-Wallet':key.publicKey()},form:createForm()});
  assert.equal(result.status,201);assert.equal(result.body.cid,cid);assert.deepEqual(uploaded,{type:'image/png',size:11});
  const invalid=new FormData();invalid.append('image',new Blob(['<svg/>'],{type:'image/svg+xml'}),'market.svg');
  assert.equal((await f.call('/market-image',{method:'POST',cookie,headers:{'X-Stellar-Wallet':key.publicKey()},form:invalid})).status,415);
});
test('logout revokes the session and profile deletion removes own off-chain rows only',async t=>{
  const f=await fixture(t),a=Keypair.random(),b=Keypair.random(),alice=await f.login(a),bob=await f.login(b);
  await f.call('/activity',{method:'POST',cookie:alice,body:{wallet:a.publicKey(),action:'claim',txHash:'b'.repeat(64)}});
  const deleted=await f.call('/me',{method:'DELETE',cookie:alice});
  assert.equal(deleted.status,200);assert.equal(deleted.body.onChainDataUnchanged,true);
  assert.equal((await f.call('/me',{cookie:alice})).status,401);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM activity').get().n,0);
  assert.equal((await f.call('/me',{cookie:bob})).status,200);
  await f.call('/logout',{method:'POST',cookie:bob});assert.equal((await f.call('/me',{cookie:bob})).status,401);
});
test('local request limiting ignores forwarded client identity',async t=>{
  const f=await fixture(t,{rateLimit:2});
  assert.equal((await f.call('/health')).status,200);
  assert.equal((await f.call('/health',{headers:{'X-Forwarded-For':'different'}})).status,200);
  assert.equal((await f.call('/health')).status,429);
});
test('SQLite state survives reopening and newer schema is refused',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'revmarket-backend-')),filename=join(directory,'test.sqlite');
  let db;
  try{
    db=openStore(filename);db.prepare('INSERT INTO users VALUES(?,?,?)').run(Keypair.random().publicKey(),1,2);db.close();db=null;
    db=openStore(filename);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n,1);
    db.exec('PRAGMA user_version=99');db.close();db=null;
    assert.throws(()=>openStore(filename),/newer/);
  }finally{
    if(db)db.close();
    for(const suffix of ['','-wal','-shm'])await unlink(filename+suffix).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await rmdir(directory);
  }
});
