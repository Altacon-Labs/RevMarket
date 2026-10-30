import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {File} from 'node:buffer';
import {Keypair,StrKey} from '@stellar/stellar-sdk';

const cookieName='revmarket_session';
const maxImageBytes=5*1024*1024;
const cidPattern=/^bafy[a-z2-7]{20,}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
class ApiError extends Error {constructor(status,message){super(message);this.status=status;}}
function object(body,fields){
  if(!body || Array.isArray(body) || typeof body!=='object' || Object.keys(body).some(k=>!fields.includes(k)))throw new ApiError(400,'Unexpected request fields');
}
async function bodyOf(req){
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw new ApiError(415,'Use application/json');
  if(Number(req.headers['content-length'])>8192){req.resume();throw new ApiError(413,'Request too large');}
  const text=await new Promise((resolve,reject)=>{
    let size=0,parts=[],failed=false;
    req.on('data',part=>{size+=part.length;if(size>8192){if(!failed)reject(new ApiError(413,'Request too large'));failed=true;parts=[];}else if(!failed)parts.push(part);});
    req.on('end',()=>{if(!failed)resolve(Buffer.concat(parts).toString('utf8'));});
    req.on('error',reject);
  });
  try{return JSON.parse(text);}catch{throw new ApiError(400,'Invalid JSON');}
}
async function bytesOf(req,limit){
  if(Number(req.headers['content-length'])>limit){req.resume();throw new ApiError(413,'Image upload exceeds 5 MB');}
  const buffer=await new Promise((resolve,reject)=>{
    let size=0,parts=[],failed=false;
    req.on('data',part=>{
      size+=part.length;
      if(size>limit){if(!failed)reject(new ApiError(413,'Image upload exceeds 5 MB'));failed=true;parts=[];req.resume();}
      else if(!failed)parts.push(part);
    });
    req.on('end',()=>{if(!failed)resolve(Buffer.concat(parts));});
    req.on('error',reject);
  });
  return buffer;
}
async function imageFileOf(req){
  const contentType=req.headers['content-type']||'';
  if(!/^multipart\/form-data\s*;\s*boundary=/i.test(contentType))throw new ApiError(415,'Upload a multipart image file');
  const bytes=await bytesOf(req,maxImageBytes+64*1024);
  let form;
  try{form=await new Request('http://localhost/upload',{method:'POST',headers:{'Content-Type':contentType},body:bytes}).formData();}
  catch{throw new ApiError(400,'Invalid multipart image upload');}
  const entries=[...form.entries()];
  if(entries.length!==1 || entries[0][0]!=='image' || typeof entries[0][1]?.arrayBuffer!=='function')throw new ApiError(400,'Upload one image using the image field');
  const file=entries[0][1];
  if(file.size===0 || file.size>maxImageBytes)throw new ApiError(413,'Image upload exceeds 5 MB');
  const image=Buffer.from(await file.arrayBuffer());
  const type=file.type.toLowerCase();
  const png=image.length>=8 && image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=image.length>=3 && image[0]===255 && image[1]===216 && image[2]===255;
  const webp=image.length>=12 && image.toString('ascii',0,4)==='RIFF' && image.toString('ascii',8,12)==='WEBP';
  const valid=(type==='image/png' && png) || (type==='image/jpeg' && jpeg) || (type==='image/webp' && webp);
  if(!valid)throw new ApiError(415,'Only valid JPEG, PNG, and WebP images are supported');
  return {bytes:image,type,name:`market-image.${type==='image/jpeg'?'jpg':type.split('/')[1]}`};
}
async function uploadToPinata(file,jwt){
  if(!jwt)throw new ApiError(503,'Image pinning is not configured. Set PINATA_JWT on the backend.');
  const form=new FormData();
  form.append('file',new File([file.bytes],file.name,{type:file.type}));
  form.append('network','public');
  form.append('name','RevMarket market artwork');
  let response;
  try{
    response=await fetch('https://uploads.pinata.cloud/v3/files',{method:'POST',headers:{Authorization:`Bearer ${jwt}`},body:form,signal:AbortSignal.timeout(25_000)});
  }catch{throw new ApiError(502,'Image pinning service is unavailable');}
  if(!response.ok)throw new ApiError(502,'Image pinning failed. Check the backend Pinata configuration.');
  let result;
  try{result=await response.json();}catch{throw new ApiError(502,'Image pinning service returned invalid data');}
  const cid=result?.data?.cid;
  if(typeof cid!=='string' || !cidPattern.test(cid))throw new ApiError(502,'Image pinning service returned an invalid CID');
  return cid;
}
function tokenOf(req){
  const value=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  return value && /^[a-f0-9]{64}$/.test(value)?value:null;
}
export function createApi({db,appOrigin='http://127.0.0.1:5173',now=()=>Math.floor(Date.now()/1000),rateLimit=120,superAdminWallets=[],pinataJwt='',uploadImage}){
  const origin=new URL(appOrigin);
  if(origin.origin!==appOrigin || origin.username || origin.password || !['http:','https:'].includes(origin.protocol))throw new Error('APP_ORIGIN must be an exact HTTP(S) origin');
  if(origin.protocol==='http:' && !['127.0.0.1','localhost','[::1]'].includes(origin.hostname))throw new Error('Non-local APP_ORIGIN requires HTTPS');
  if(!Array.isArray(superAdminWallets) || superAdminWallets.some(wallet=>!StrKey.isValidEd25519PublicKey(wallet)))throw new Error('SUPER_ADMIN_WALLETS must contain valid Stellar G-addresses');
  const superAdmins=new Set(superAdminWallets);
  const buckets=new Map();
  const cookie=(value,seconds)=>`${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=${seconds}${origin.protocol==='https:'?'; Secure':''}`;
  const cleanup=()=>{db.prepare('DELETE FROM challenges WHERE expires_at<=?').run(now());db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now());};
  const session=req=>{
    const token=tokenOf(req);
    const row=token && db.prepare('SELECT wallet FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token),now());
    if(!row)throw new ApiError(401,'Sign in to activity tracking');
    return row.wallet;
  };
  const server=createServer(async(req,res)=>{
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer'};
    const send=(status,data,extra={})=>{res.writeHead(status,{...headers,...extra});res.end(JSON.stringify(data));};
    try{
      if(req.headers.origin && req.headers.origin!==appOrigin)throw new ApiError(403,'Origin not allowed');
      if(!['GET','HEAD'].includes(req.method) && req.headers.origin!==appOrigin)throw new ApiError(403,'Matching Origin header required');
      const time=now(),ip=req.socket.remoteAddress;
      for(const [key,b] of buckets)if(time-b.start>=60)buckets.delete(key);
      if(!buckets.has(ip)){if(buckets.size>=1000)throw new ApiError(503,'Try later');buckets.set(ip,{start:time,count:0});}
      if(++buckets.get(ip).count>rateLimit)throw new ApiError(429,'Too many requests');
      cleanup();
      const url=new URL(req.url,'http://localhost');
      const route=req.method+' '+url.pathname;
      if(route==='GET /api/health'){
        db.prepare('SELECT 1').get();
        return send(200,{status:'ok',service:'revmarket-api',version:1,network:'testnet',automationEnabled:false});
      }
      if(route==='POST /api/auth/challenge'){
        const body=await bodyOf(req);object(body,['wallet']);
        if(typeof body.wallet!=='string' || !StrKey.isValidEd25519PublicKey(body.wallet))throw new ApiError(400,'Valid Stellar G-address required');
        // Only one outstanding challenge per public key; all challenges expire quickly.
        db.prepare('DELETE FROM challenges WHERE wallet=?').run(body.wallet);
        const id=randomBytes(24).toString('hex'),expiresAt=time+120;
        const message=`RevMarket sign-in\nOrigin: ${appOrigin}\nNetwork: Stellar Testnet\nWallet: ${body.wallet}\nNonce: ${id}\nIssued at: ${time}\nExpires at: ${expiresAt}\nPurpose: Off-chain activity profile only. No transaction or automation authority.`;
        db.prepare('INSERT INTO challenges VALUES(?,?,?,?)').run(id,body.wallet,message,expiresAt);
        return send(200,{id,wallet:body.wallet,message,expiresAt,origin:appOrigin});
      }
      if(route==='POST /api/auth/verify'){
        const body=await bodyOf(req);object(body,['id','signature']);
        if(typeof body.id!=='string' || !/^[a-f0-9]{48}$/.test(body.id) || typeof body.signature!=='string' || !/^[A-Za-z0-9+/]{86}==$/.test(body.signature))throw new ApiError(400,'Invalid challenge or signature encoding');
        const challenge=db.prepare('SELECT * FROM challenges WHERE id=?').get(body.id);
        // Consumption precedes verification; failed attempts cannot reuse a nonce.
        db.prepare('DELETE FROM challenges WHERE id=?').run(body.id);
        if(!challenge || challenge.expires_at<=now() || !Keypair.fromPublicKey(challenge.wallet).verifyMessage(challenge.message,Buffer.from(body.signature,'base64')))throw new ApiError(401,'Invalid or expired signature');
        const token=randomBytes(32).toString('hex');
        db.exec('BEGIN IMMEDIATE');
        try{
          db.prepare('INSERT INTO users VALUES(?,?,?) ON CONFLICT(wallet) DO UPDATE SET last_login=excluded.last_login').run(challenge.wallet,time,time);
          const oldToken=tokenOf(req);if(oldToken)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(oldToken));
          db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),challenge.wallet,time+3600);
          db.exec('COMMIT');
        }catch(e){db.exec('ROLLBACK');throw e;}
        return send(200,{wallet:challenge.wallet,expiresAt:time+3600},{'Set-Cookie':cookie(token,3600)});
      }
      if(route==='POST /api/logout'){
        const token=tokenOf(req);if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
        return send(200,{signedOut:true},{'Set-Cookie':cookie('',0)});
      }
      if(route==='GET /api/me'){
        const wallet=session(req);
        return send(200,{...db.prepare('SELECT wallet,created_at AS createdAt,last_login AS lastLogin FROM users WHERE wallet=?').get(wallet),automationEnabled:false});
      }
      if(route==='GET /api/admin/network'){
        const wallet=session(req);
        if(!superAdmins.has(wallet))throw new ApiError(403,'Super-admin access required');
        return send(200,{role:'super_admin',activeNetwork:'testnet',networks:{testnet:{available:true},mainnet:{available:false,reason:'Mainnet is not deployed or supported by this application.'}}});
      }
      if(route==='POST /api/market-image'){
        const wallet=session(req);
        if(req.headers['x-stellar-wallet']!==wallet)throw new ApiError(403,'Connected wallet does not match the signed image-upload session');
        const file=await imageFileOf(req);
        const cid=uploadImage?await uploadImage(file):await uploadToPinata(file,pinataJwt);
        if(typeof cid!=='string' || !cidPattern.test(cid))throw new ApiError(502,'Image pinning service returned an invalid CID');
        return send(201,{cid});
      }
      if(route==='GET /api/activity'){
        const wallet=session(req);
        const items=db.prepare('SELECT id,action,tx_hash AS txHash,created_at AS createdAt FROM activity WHERE wallet=? ORDER BY id DESC LIMIT 50').all(wallet);
        return send(200,{items:items.map(item=>({...item,verification:'unverified_client_report'}))});
      }
      if(route==='POST /api/activity'){
        const wallet=session(req),body=await bodyOf(req);object(body,['wallet','action','txHash']);
        if(body.wallet!==wallet)throw new ApiError(403,'Connected wallet does not match signed-in profile');
        if(!['create','predict','request','claim'].includes(body.action) || typeof body.txHash!=='string' || !/^[a-f0-9]{64}$/.test(body.txHash))throw new ApiError(400,'Invalid activity');
        db.prepare('INSERT OR IGNORE INTO activity(wallet,action,tx_hash,created_at) VALUES(?,?,?,?)').run(wallet,body.action,body.txHash,time);
        db.prepare('DELETE FROM activity WHERE wallet=? AND id NOT IN(SELECT id FROM activity WHERE wallet=? ORDER BY id DESC LIMIT 1000)').run(wallet,wallet);
        return send(200,{recorded:true,verification:'unverified_client_report'});
      }
      if(route==='DELETE /api/me'){
        const wallet=session(req);
        db.exec('BEGIN IMMEDIATE');
        try{db.prepare('DELETE FROM challenges WHERE wallet=?').run(wallet);db.prepare('DELETE FROM users WHERE wallet=?').run(wallet);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
        return send(200,{deleted:true,onChainDataUnchanged:true},{'Set-Cookie':cookie('',0)});
      }
      throw new ApiError(404,'Endpoint not found');
    }catch(e){
      // Never echo bodies, cookies, signatures or internal database errors.
      if(!res.headersSent)send(e.status||500,{error:e.status?e.message:'Internal server error'},e.status===413?{'Connection':'close'}:{});
      else res.end();
    }
  });
  server.requestTimeout=15_000;server.headersTimeout=10_000;server.keepAliveTimeout=5000;
  return server;
}
