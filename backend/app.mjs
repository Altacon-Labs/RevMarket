import {createServer} from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import {File} from 'node:buffer';
import {Keypair,StrKey} from '@stellar/stellar-sdk';

const cookieName='revmarket_session';
const maxImageBytes=5*1024*1024;
const cidPattern=/^bafy[a-z2-7]{20,}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const contentHash=obj=>createHash('sha256').update(JSON.stringify(obj,Object.keys(obj).sort())).digest('hex');
const draftFields=['question','category','tradingClose','observationTime','resolutionDeadline','yesRule','noRule','equalityRule','sources','fallbackRule','unavailableDataRule','collateral','feeBps','resolver','policyVersion','implementationVersion','metadata','origin'];
const draftRevisionFields=['question','category','metadata_json','trading_close','observation_time','resolution_deadline','yes_rule','no_rule','equality_rule','sources_json','fallback_rule','unavailable_data_rule','collateral','fee_bps','resolver','policy_version','implementation_version'];
function validateDraftBody(body){
  if(typeof body.question!=='string'||body.question.length===0||body.question.length>512)throw new ApiError(400,'Question must be 1–512 characters');
  if(typeof body.tradingClose!=='number'||!Number.isSafeInteger(body.tradingClose)||body.tradingClose<=0)throw new ApiError(400,'Valid trading close timestamp required');
  if(body.feeBps!==undefined&&(typeof body.feeBps!=='number'||!Number.isSafeInteger(body.feeBps)||body.feeBps<0||body.feeBps>1000))throw new ApiError(400,'Fee basis points must be 0–1000');
  if(body.sources!==undefined&&!Array.isArray(body.sources))throw new ApiError(400,'Sources must be an array');
  if(body.metadata!==undefined&&(typeof body.metadata!=='object'||Array.isArray(body.metadata)||body.metadata===null))throw new ApiError(400,'Metadata must be an object');
}
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
export function createApi({db,appOrigin='http://127.0.0.1:5173',now=()=>Math.floor(Date.now()/1000),rateLimit=120,superAdminWallets=[],pinataJwt='',uploadImage,reviewerWallets=[],aiConfig=null,getAiSuggestionsFn=null}){
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
      // --- Reviewer role management (super-admin only) ---
      if(route==='GET /api/admin/reviewers'){
        const wallet=session(req);
        if(!superAdmins.has(wallet))throw new ApiError(403,'Super-admin access required');
        const rows=db.prepare('SELECT wallet,added_by AS addedBy,added_at AS addedAt,revoked_at AS revokedAt FROM reviewers ORDER BY added_at DESC').all();
        return send(200,{reviewers:rows});
      }
      if(route==='POST /api/admin/reviewers'){
        const wallet=session(req);
        if(!superAdmins.has(wallet))throw new ApiError(403,'Super-admin access required');
        const body=await bodyOf(req);object(body,['wallet','action']);
        if(typeof body.wallet!=='string'||!StrKey.isValidEd25519PublicKey(body.wallet))throw new ApiError(400,'Valid Stellar G-address required');
        if(!['add','revoke'].includes(body.action))throw new ApiError(400,'Action must be add or revoke');
        if(body.action==='add'){
          const existing=db.prepare('SELECT revoked_at FROM reviewers WHERE wallet=?').get(body.wallet);
          if(existing&&existing.revoked_at===null)throw new ApiError(409,'Reviewer is already active');
          if(existing)db.prepare('UPDATE reviewers SET added_by=?,added_at=?,revoked_at=NULL WHERE wallet=?').run(wallet,time,body.wallet);
          else db.prepare('INSERT INTO reviewers VALUES(?,?,?,NULL)').run(body.wallet,wallet,time);
          db.prepare('INSERT INTO audit_events(draft_id,actor_wallet,action,detail_json,created_at) VALUES(NULL,?,?,?,?)').run(wallet,'reviewer_added',JSON.stringify({reviewer:body.wallet}),time);
        }else{
          const existing=db.prepare('SELECT revoked_at FROM reviewers WHERE wallet=?').get(body.wallet);
          if(!existing||existing.revoked_at!==null)throw new ApiError(404,'Reviewer not found or already revoked');
          db.prepare('UPDATE reviewers SET revoked_at=? WHERE wallet=?').run(time,body.wallet);
          // Invalidate any pending approvals by this reviewer
          db.prepare("UPDATE drafts SET status='draft',updated_at=? WHERE status='approved' AND id IN (SELECT draft_id FROM review_decisions WHERE reviewer_wallet=? AND decision='approved')").run(time,body.wallet);
          db.prepare('INSERT INTO audit_events(draft_id,actor_wallet,action,detail_json,created_at) VALUES(NULL,?,?,?,?)').run(wallet,'reviewer_revoked',JSON.stringify({reviewer:body.wallet}),time);
        }
        return send(200,{updated:true});
      }
      // --- Draft management ---
      if(route==='POST /api/drafts'){
        const wallet=session(req);
        const body=await bodyOf(req);object(body,draftFields);
        validateDraftBody(body);
        const draftOrigin=body.origin==='ai_assisted'?'ai_assisted':'manual';
        db.exec('BEGIN IMMEDIATE');
        try{
          const result=db.prepare('INSERT INTO drafts(owner_wallet,origin,status,created_at,updated_at) VALUES(?,?,?,?,?)').run(wallet,draftOrigin,'draft',time,time);
          const draftId=Number(result.lastInsertRowid);
          const revContent={question:body.question,category:body.category||'',tradingClose:body.tradingClose,yesRule:body.yesRule||'',noRule:body.noRule||'',equalityRule:body.equalityRule||'',sources:body.sources||[],fallbackRule:body.fallbackRule||'',collateral:body.collateral||'native',feeBps:body.feeBps||0,resolver:body.resolver||'',implementationVersion:body.implementationVersion||''};
          const ch=contentHash(revContent);
          const revResult=db.prepare('INSERT INTO draft_revisions(draft_id,revision_number,question,category,metadata_json,trading_close,observation_time,resolution_deadline,yes_rule,no_rule,equality_rule,sources_json,fallback_rule,unavailable_data_rule,collateral,fee_bps,resolver,policy_version,implementation_version,content_hash,created_at) VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(draftId,body.question,body.category||'',JSON.stringify(body.metadata||{}),body.tradingClose,body.observationTime||null,body.resolutionDeadline||null,body.yesRule||'',body.noRule||'',body.equalityRule||'',JSON.stringify(body.sources||[]),body.fallbackRule||'',body.unavailableDataRule||'',body.collateral||'native',body.feeBps||0,body.resolver||'',body.policyVersion||'',body.implementationVersion||'',ch,time);
          const revId=Number(revResult.lastInsertRowid);
          db.prepare('UPDATE drafts SET current_revision_id=? WHERE id=?').run(revId,draftId);
          db.prepare('INSERT INTO audit_events(draft_id,actor_wallet,action,detail_json,created_at) VALUES(?,?,?,?,?)').run(draftId,wallet,'created',JSON.stringify({revisionId:revId}),time);
          db.exec('COMMIT');
          return send(201,{id:draftId,revisionId:revId,contentHash:ch});
        }catch(e){db.exec('ROLLBACK');throw e;}
      }
      if(route==='GET /api/drafts'){
        const wallet=session(req);
        const rows=db.prepare('SELECT d.id,d.origin,d.status,d.created_at AS createdAt,d.updated_at AS updatedAt,r.question,r.revision_number AS revisionNumber FROM drafts d LEFT JOIN draft_revisions r ON r.id=d.current_revision_id WHERE d.owner_wallet=? ORDER BY d.id DESC LIMIT 100').all(wallet);
        return send(200,{drafts:rows});
      }
      if(url.pathname.startsWith('/api/drafts/')&&!url.pathname.includes('/api/drafts/0')){
        const draftIdStr=url.pathname.split('/')[3];
        const subPath=url.pathname.split('/').slice(4).join('/');
        const draftId=Number(draftIdStr);
        if(!Number.isSafeInteger(draftId)||draftId<=0)throw new ApiError(400,'Invalid draft ID');
        // GET /api/drafts/:id
        if(req.method==='GET'&&!subPath){
          const wallet=session(req);
          const draft=db.prepare('SELECT id,owner_wallet AS ownerWallet,origin,status,created_at AS createdAt,updated_at AS updatedAt FROM drafts WHERE id=?').get(draftId);
          if(!draft)throw new ApiError(404,'Draft not found');
          // Owners and active reviewers can view drafts
          const reviewer=db.prepare('SELECT wallet FROM reviewers WHERE wallet=? AND revoked_at IS NULL').get(wallet);
          if(draft.ownerWallet!==wallet&&!reviewer&&!superAdmins.has(wallet))throw new ApiError(403,'Access denied');
          const revisions=db.prepare('SELECT id,revision_number AS revisionNumber,question,category,metadata_json AS metadataJson,trading_close AS tradingClose,observation_time AS observationTime,resolution_deadline AS resolutionDeadline,yes_rule AS yesRule,no_rule AS noRule,equality_rule AS equalityRule,sources_json AS sourcesJson,fallback_rule AS fallbackRule,unavailable_data_rule AS unavailableDataRule,collateral,fee_bps AS feeBps,resolver,policy_version AS policyVersion,implementation_version AS implementationVersion,content_hash AS contentHash,created_at AS createdAt FROM draft_revisions WHERE draft_id=? ORDER BY revision_number DESC').all(draftId);
          const reviews=db.prepare('SELECT id,revision_id AS revisionId,reviewer_wallet AS reviewerWallet,decision,reason,approved_params_hash AS approvedParamsHash,expiry,created_at AS createdAt FROM review_decisions WHERE draft_id=? ORDER BY id DESC').all(draftId);
          return send(200,{draft,revisions,reviews});
        }
        // PUT /api/drafts/:id — update (creates new revision, invalidates approval)
        if(req.method==='PUT'&&!subPath){
          const wallet=session(req);
          const body=await bodyOf(req);object(body,draftFields);
          validateDraftBody(body);
          const draft=db.prepare('SELECT * FROM drafts WHERE id=?').get(draftId);
          if(!draft)throw new ApiError(404,'Draft not found');
          if(draft.owner_wallet!==wallet)throw new ApiError(403,'Only the owner can edit a draft');
          if(!['draft','changes_requested','approved'].includes(draft.status))throw new ApiError(409,`Cannot edit a draft in status: ${draft.status}`);
          db.exec('BEGIN IMMEDIATE');
          try{
            const maxRev=db.prepare('SELECT MAX(revision_number) AS n FROM draft_revisions WHERE draft_id=?').get(draftId).n||0;
            const revContent={question:body.question,category:body.category||'',tradingClose:body.tradingClose,yesRule:body.yesRule||'',noRule:body.noRule||'',equalityRule:body.equalityRule||'',sources:body.sources||[],fallbackRule:body.fallbackRule||'',collateral:body.collateral||'native',feeBps:body.feeBps||0,resolver:body.resolver||'',implementationVersion:body.implementationVersion||''};
            const ch=contentHash(revContent);
            const revResult=db.prepare('INSERT INTO draft_revisions(draft_id,revision_number,question,category,metadata_json,trading_close,observation_time,resolution_deadline,yes_rule,no_rule,equality_rule,sources_json,fallback_rule,unavailable_data_rule,collateral,fee_bps,resolver,policy_version,implementation_version,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(draftId,maxRev+1,body.question,body.category||'',JSON.stringify(body.metadata||{}),body.tradingClose,body.observationTime||null,body.resolutionDeadline||null,body.yesRule||'',body.noRule||'',body.equalityRule||'',JSON.stringify(body.sources||[]),body.fallbackRule||'',body.unavailableDataRule||'',body.collateral||'native',body.feeBps||0,body.resolver||'',body.policyVersion||'',body.implementationVersion||'',ch,time);
            const revId=Number(revResult.lastInsertRowid);
            // Editing an approved draft resets to draft and invalidates approval
            const newStatus=draft.status==='approved'?'draft':draft.status==='changes_requested'?'draft':draft.status;
            db.prepare('UPDATE drafts SET current_revision_id=?,status=?,updated_at=? WHERE id=?').run(revId,newStatus,time,draftId);
            db.prepare('INSERT INTO audit_events(draft_id,actor_wallet,action,detail_json,created_at) VALUES(?,?,?,?,?)').run(draftId,wallet,'revised',JSON.stringify({revisionId:revId,revisionNumber:maxRev+1,previousStatus:draft.status}),time);
            db.exec('COMMIT');
            return send(200,{revisionId:revId,revisionNumber:maxRev+1,contentHash:ch,status:newStatus});
          }catch(e){db.exec('ROLLBACK');throw e;}
        }
        // POST /api/drafts/:id/submit
        if(req.method==='POST'&&subPath==='submit'){
          const wallet=session(req);
          const draft=db.prepare('SELECT * FROM drafts WHERE id=?').get(draftId);
          if(!draft)throw new ApiError(404,'Draft not found');
          if(draft.owner_wallet!==wallet)throw new ApiError(403,'Only the owner can submit a draft');
          if(!['draft','changes_requested'].includes(draft.status))throw new ApiError(409,`Cannot submit a draft in status: ${draft.status}`);
          db.prepare("UPDATE drafts SET status='submitted',updated_at=? WHERE id=?").run(time,draftId);
          db.prepare('INSERT INTO audit_events(draft_id,actor_wallet,action,detail_json,created_at) VALUES(?,?,?,?,?)').run(draftId,wallet,'submitted','{}',time);
          return send(200,{status:'submitted'});
        }
        // POST /api/drafts/:id/withdraw
        if(req.method==='POST'&&subPath==='withdraw'){
          const wallet=session(req);
          const draft=db.prepare('SELECT * FROM drafts WHERE id=?').get(draftId);
          if(!draft)throw new ApiError(404,'Draft not found');
          if(draft.owner_wallet!==wallet)throw new ApiError(403,'Only the owner can withdraw a draft');
          if(!['submitted','approved'].includes(draft.status))throw new ApiError(409,`Cannot withdraw a draft in status: ${draft.status}`);
          db.prepare("UPDATE drafts SET status='draft',updated_at=? WHERE id=?").run(time,draftId);
          db.prepare('INSERT INTO audit_events(draft_id,actor_wallet,action,detail_json,created_at) VALUES(?,?,?,?,?)').run(draftId,wallet,'withdrawn',JSON.stringify({previousStatus:draft.status}),time);
          return send(200,{status:'draft'});
        }
        // POST /api/drafts/:id/review — reviewer decision
        if(req.method==='POST'&&subPath==='review'){
          const wallet=session(req);
          const reviewer=db.prepare('SELECT wallet FROM reviewers WHERE wallet=? AND revoked_at IS NULL').get(wallet);
          if(!reviewer)throw new ApiError(403,'Active reviewer role required');
          const body=await bodyOf(req);object(body,['decision','reason','expiry']);
          if(!['changes_requested','rejected','approved'].includes(body.decision))throw new ApiError(400,'Decision must be changes_requested, rejected, or approved');
          const draft=db.prepare('SELECT * FROM drafts WHERE id=?').get(draftId);
          if(!draft)throw new ApiError(404,'Draft not found');
          if(draft.status!=='submitted')throw new ApiError(409,'Only submitted drafts can be reviewed');
          if(draft.owner_wallet===wallet)throw new ApiError(403,'Reviewers cannot review their own drafts');
          const revision=db.prepare('SELECT * FROM draft_revisions WHERE id=?').get(draft.current_revision_id);
          db.exec('BEGIN IMMEDIATE');
          try{
            let approvedHash=null,expiry=null;
            if(body.decision==='approved'){
              approvedHash=revision.content_hash;
              expiry=body.expiry||(time+86400); // Default 24h expiry
              if(expiry<=time)throw new ApiError(400,'Expiry must be in the future');
            }
            db.prepare('INSERT INTO review_decisions(draft_id,revision_id,reviewer_wallet,decision,reason,approved_params_hash,expiry,created_at) VALUES(?,?,?,?,?,?,?,?)').run(draftId,draft.current_revision_id,wallet,body.decision,body.reason||'',approvedHash,expiry,time);
            const statusMap={changes_requested:'changes_requested',rejected:'rejected',approved:'approved'};
            db.prepare('UPDATE drafts SET status=?,updated_at=? WHERE id=?').run(statusMap[body.decision],time,draftId);
            db.prepare('INSERT INTO audit_events(draft_id,actor_wallet,action,detail_json,created_at) VALUES(?,?,?,?,?)').run(draftId,wallet,'reviewed',JSON.stringify({decision:body.decision,revisionId:draft.current_revision_id,approvedHash,expiry}),time);
            db.exec('COMMIT');
            return send(200,{status:statusMap[body.decision],approvedParamsHash:approvedHash,expiry});
          }catch(e){db.exec('ROLLBACK');throw e;}
        }
        // POST /api/drafts/:id/ai-assist — AI drafting suggestions
        if(req.method==='POST'&&subPath==='ai-assist'){
          const wallet=session(req);
          const draft=db.prepare('SELECT * FROM drafts WHERE id=?').get(draftId);
          if(!draft)throw new ApiError(404,'Draft not found');
          if(draft.owner_wallet!==wallet)throw new ApiError(403,'Only the owner can request AI assistance');
          if(!['draft','changes_requested'].includes(draft.status))throw new ApiError(409,'AI assistance is only available for editable drafts');
          if(!getAiSuggestionsFn&&!aiConfig)throw new ApiError(503,'AI assistance is not configured');
          const revision=db.prepare('SELECT * FROM draft_revisions WHERE id=?').get(draft.current_revision_id);
          if(!revision)throw new ApiError(404,'No revision found');
          const draftInput={question:revision.question,category:revision.category,yesRule:revision.yes_rule,noRule:revision.no_rule,sources:JSON.parse(revision.sources_json||'[]')};
          let suggestions;
          try{
            if(getAiSuggestionsFn){suggestions=await getAiSuggestionsFn(draftInput);}
            else{const{getAiSuggestions}=await import('./ai.mjs');suggestions=await getAiSuggestions({...aiConfig,draft:draftInput});}
          }catch(e){throw new ApiError(502,`AI assistance failed: ${e.message}`);}
          db.prepare('INSERT INTO audit_events(draft_id,actor_wallet,action,detail_json,created_at) VALUES(?,?,?,?,?)').run(draftId,wallet,'ai_assisted',JSON.stringify({model:suggestions.model||'unknown',inputHash:suggestions.inputHash||''}),time);
          // Mark draft origin as ai_assisted if it was manual
          if(draft.origin==='manual')db.prepare("UPDATE drafts SET origin='ai_assisted',updated_at=? WHERE id=?").run(time,draftId);
          return send(200,{suggestions});
        }
      }
      // GET /api/review-queue — list submitted drafts (reviewer or super-admin only)
      if(route==='GET /api/review-queue'){
        const wallet=session(req);
        const reviewer=db.prepare('SELECT wallet FROM reviewers WHERE wallet=? AND revoked_at IS NULL').get(wallet);
        if(!reviewer&&!superAdmins.has(wallet))throw new ApiError(403,'Active reviewer or super-admin role required');
        const rows=db.prepare("SELECT d.id,d.owner_wallet AS ownerWallet,d.origin,d.status,d.created_at AS createdAt,d.updated_at AS updatedAt,r.question,r.revision_number AS revisionNumber,r.content_hash AS contentHash FROM drafts d LEFT JOIN draft_revisions r ON r.id=d.current_revision_id WHERE d.status='submitted' ORDER BY d.updated_at ASC LIMIT 100").all();
        return send(200,{queue:rows});
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
