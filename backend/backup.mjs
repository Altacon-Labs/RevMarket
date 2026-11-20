// Online SQLite backup, restore verification and guarded promotion for the local backend.
// Library only: no process.exit, no console output except the optional onWarning/onLog callbacks.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,constants as fsConstants} from 'node:fs';
import {chmod,copyFile,link,lstat,mkdir,open,readFile,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {request} from 'node:http';
import {performance} from 'node:perf_hooks';
import {openStore} from './store.mjs';

export class BackupError extends Error{
  constructor(code,message,details){super(message);this.name='BackupError';this.code=code;if(details!==undefined)this.details=details;}
}

const MIN_SCHEMA_VERSION=2;
const REQUIRED_TABLES=['drafts','draft_revisions','review_decisions'];
const SIDECARS=['-wal','-shm','-journal'];
const DETAIL_LIMIT=20;
const repoRoot=fileURLToPath(new URL('../',import.meta.url));

let supportedCache;
// The newest schema this backend can open, taken from the migrations in store.mjs rather than hard-coded.
export function supportedSchemaVersion(){
  if(supportedCache===undefined){
    const db=openStore(':memory:');
    try{supportedCache=db.prepare('PRAGMA user_version').get().user_version;}finally{db.close();}
  }
  return supportedCache;
}

// 2026-11-19T10:22:05.123Z -> 2026-11-19T10-22-05Z (no ':' so the name is valid on Windows).
export function fileTimestamp(date){
  return date.toISOString().replace(/\.\d{3}Z$/,'Z').replace(/:/g,'-');
}

export async function sha256File(file){
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(file))hash.update(chunk);
  return hash.digest('hex');
}

const quoteIdent=name=>'"'+String(name).replace(/"/g,'""')+'"';
const exists=async path=>{try{await lstat(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};

function schemaRangeError(found){
  const supported=supportedSchemaVersion();
  return new BackupError('SCHEMA_UNSUPPORTED',`schema version ${found} is not supported; this backend restores versions ${MIN_SCHEMA_VERSION} to ${supported}`,{found,supported,minimum:MIN_SCHEMA_VERSION});
}
const inSchemaRange=version=>Number.isInteger(version)&&version>=MIN_SCHEMA_VERSION&&version<=supportedSchemaVersion();

function listTables(db){
  return db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row=>row.name);
}
function countRows(db,tables){
  const counts={};
  for(const table of tables)counts[table]=Number(db.prepare(`SELECT count(*) AS n FROM ${quoteIdent(table)}`).get().n);
  return counts;
}
function integrityRows(db,pragma){
  return db.prepare(`PRAGMA ${pragma}`).all().map(row=>Object.values(row)[0]);
}

async function isInsideRepo(dir){
  try{
    const [realDir,realRepo]=await Promise.all([realpath(dir),realpath(repoRoot)]);
    const rel=relative(realRepo,realDir);
    return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));
  }catch{return false;}
}

// Publish src under dest without ever replacing an existing file. link() fails with EEXIST when dest exists;
// on file systems without hard links, fall back to an existence check plus rename. The caller removes src.
async function publishNoOverwrite(src,dest){
  try{await link(src,dest);}
  catch(e){
    if(e.code==='EEXIST')throw new BackupError('BACKUP_EXISTS',`refusing to overwrite existing file ${dest}`);
    if(!['EPERM','ENOTSUP','EXDEV','ENOSYS','EINVAL'].includes(e.code))throw e;
    if(await exists(dest))throw new BackupError('BACKUP_EXISTS',`refusing to overwrite existing file ${dest}`);
    await rename(src,dest);
  }
}

/**
 * Take a transactionally consistent snapshot of a live WAL database with VACUUM INTO.
 * Counts, integrity and the hash are read from the backup file, never from the live database.
 */
export async function createBackup({source,outDir,now=()=>new Date(),onWarning=()=>{}}={}){
  if(typeof source!=='string'||!source)throw new BackupError('SOURCE_NOT_FOUND','no source database path given');
  if(typeof outDir!=='string'||!outDir)throw new BackupError('OUT_DIR_NOT_FOUND','no output directory given');
  source=resolve(source);outDir=resolve(outDir);
  let sourceStat;
  try{sourceStat=await stat(source);}catch(e){if(e.code==='ENOENT')throw new BackupError('SOURCE_NOT_FOUND',`source database ${source} does not exist`);throw e;}
  if(!sourceStat.isFile())throw new BackupError('SOURCE_NOT_FOUND',`source ${source} is not a file`);
  let outStat;
  try{outStat=await stat(outDir);}catch(e){if(e.code==='ENOENT')throw new BackupError('OUT_DIR_NOT_FOUND',`output directory ${outDir} does not exist`);throw e;}
  if(!outStat.isDirectory())throw new BackupError('OUT_DIR_NOT_FOUND',`output path ${outDir} is not a directory`);
  if(await isInsideRepo(outDir))onWarning(`output directory ${outDir} is inside the repository working tree; store backups outside the repository`);

  const createdAt=now();
  const ts=fileTimestamp(createdAt);
  const partial=join(outDir,`.revmarket-${ts}.${process.pid}.${randomUUID()}.partial`);
  let finalPath,manifestPath,manifestCreated=false,finalCreated=false;
  try{
    const src=new DatabaseSync(source);
    try{
      try{src.exec('PRAGMA busy_timeout=5000');src.prepare('SELECT count(*) FROM sqlite_schema').get();}
      catch(e){throw new BackupError('SOURCE_NOT_SQLITE',`source ${source} could not be read as SQLite: ${e.message}`);}
      // One statement, one read transaction: a point-in-time snapshot that includes committed WAL frames.
      try{src.prepare('VACUUM INTO ?').run(partial);}
      catch(e){throw new BackupError('BACKUP_FAILED',`VACUUM INTO failed: ${e.message}`);}
    }finally{src.close();}

    let userVersion,tables,integrity;
    const snap=new DatabaseSync(partial);
    try{
      snap.exec('PRAGMA query_only=1');
      integrity=integrityRows(snap,'integrity_check');
      userVersion=snap.prepare('PRAGMA user_version').get().user_version;
      tables=countRows(snap,listTables(snap));
    }finally{snap.close();}
    if(integrity.length!==1||integrity[0]!=='ok')throw new BackupError('BACKUP_INTEGRITY_FAILED','integrity_check failed on the new backup',integrity.slice(0,DETAIL_LIMIT));
    if(!inSchemaRange(userVersion))throw schemaRangeError(userVersion);

    const [sha256,{size:bytes}]=await Promise.all([sha256File(partial),stat(partial)]);
    try{await chmod(partial,0o600);}catch{/* best effort; NTFS ignores POSIX modes */}
    const name=`revmarket-${ts}-v${userVersion}`;
    finalPath=join(outDir,`${name}.sqlite`);
    manifestPath=join(outDir,`${name}.manifest.json`);
    if(await exists(manifestPath))throw new BackupError('BACKUP_EXISTS',`refusing to overwrite existing file ${manifestPath}`);
    await publishNoOverwrite(partial,finalPath);
    finalCreated=true;
    const manifest={format:1,file:basename(finalPath),sha256,bytes,userVersion,createdAt:createdAt.toISOString(),tables,method:'VACUUM INTO'};
    const handle=await open(manifestPath,'wx',0o600);
    manifestCreated=true;
    try{await handle.writeFile(JSON.stringify(manifest,null,2)+'\n');await handle.sync();}finally{await handle.close();}
    return {manifest,backupPath:finalPath,manifestPath};
  }catch(e){
    if(manifestCreated)await rm(manifestPath,{force:true});
    if(finalCreated)await rm(finalPath,{force:true});
    throw e;
  }finally{
    await rm(partial,{force:true});
  }
}

function validateManifest(m){
  const bad=msg=>new BackupError('MANIFEST_INVALID',`manifest is invalid: ${msg}`);
  if(!m||typeof m!=='object'||Array.isArray(m))throw bad('not a JSON object');
  if(m.format!==1)throw bad('unsupported format');
  if(typeof m.sha256!=='string'||!/^[0-9a-f]{64}$/.test(m.sha256))throw bad('sha256 must be 64 lowercase hex characters');
  if(!Number.isInteger(m.userVersion))throw bad('userVersion must be an integer');
  if(!m.tables||typeof m.tables!=='object'||Array.isArray(m.tables))throw bad('tables must be an object');
  for(const [k,v] of Object.entries(m.tables))if(!Number.isSafeInteger(v)||v<0)throw bad(`row count for ${k} must be a non-negative integer`);
}

const SQLITE_HEADER=Buffer.from('SQLite format 3\0','latin1');
async function hasSqliteHeader(file){
  const handle=await open(file,'r');
  try{const buf=Buffer.alloc(16);const {bytesRead}=await handle.read(buf,0,16,0);return bytesRead===16&&buf.equals(SQLITE_HEADER);}
  finally{await handle.close();}
}

/**
 * Copy a backup into a new, empty target directory and verify the copy. Never touches the active database.
 * Writes target/verify-report.json (ok:true or ok:false) whenever the target directory was created.
 */
export async function verifyRestore({backup,manifest,target,now=()=>new Date()}={}){
  if(typeof backup!=='string'||!backup)throw new BackupError('BACKUP_NOT_FOUND','no backup file given');
  if(typeof target!=='string'||!target)throw new BackupError('TARGET_REQUIRED','no target directory given');
  backup=resolve(backup);target=resolve(target);
  manifest=resolve(manifest??backup.replace(/\.sqlite$/i,'')+'.manifest.json');
  if(await exists(target))throw new BackupError('TARGET_EXISTS',`target ${target} already exists; restore verification needs a new, empty location`);
  let backupStat;
  try{backupStat=await stat(backup);}catch(e){if(e.code==='ENOENT')throw new BackupError('BACKUP_NOT_FOUND',`backup ${backup} does not exist`);throw e;}
  if(!backupStat.isFile())throw new BackupError('BACKUP_NOT_FOUND',`backup ${backup} is not a file`);
  let man;
  try{man=JSON.parse(await readFile(manifest,'utf8'));}
  catch(e){
    if(e.code==='ENOENT')throw new BackupError('MANIFEST_NOT_FOUND',`manifest ${manifest} does not exist`);
    throw new BackupError('MANIFEST_INVALID',`manifest ${manifest} is not valid JSON`);
  }
  validateManifest(man);

  try{await mkdir(target,{mode:0o700});}
  catch(e){
    if(e.code==='EEXIST')throw new BackupError('TARGET_EXISTS',`target ${target} already exists; restore verification needs a new, empty location`);
    if(e.code==='ENOENT')throw new BackupError('TARGET_PARENT_NOT_FOUND',`parent directory of ${target} does not exist`);
    throw e;
  }

  const copy=join(target,'revmarket.sqlite');
  const reportPath=join(target,'verify-report.json');
  const checks={hash:'pending',sqlite:'pending',integrity:'pending',schemaVersion:'pending',foreignKeys:'pending',drafts:'pending',reviews:'pending',revisionNumbers:'pending',rowCounts:'pending'};
  const report={ok:false,backup:basename(backup),checks,sha256:null,userVersion:null,supportedSchemaVersion:supportedSchemaVersion(),tables:null,sample:null,verifiedAt:null};
  const fail=(check,err)=>{checks[check]='failed';throw err;};
  let db;
  try{
    await copyFile(backup,copy,fsConstants.COPYFILE_EXCL);
    const [copyHash,backupHash]=await Promise.all([sha256File(copy),sha256File(backup)]);
    report.sha256=copyHash;
    if(copyHash!==man.sha256||copyHash!==backupHash)fail('hash',new BackupError('HASH_MISMATCH',`restored copy sha256 ${copyHash} does not match the manifest (${man.sha256}) and source backup (${backupHash})`));
    checks.hash='ok';

    if(!await hasSqliteHeader(copy))fail('sqlite',new BackupError('NOT_SQLITE','restored copy is not an SQLite database (bad header)'));
    db=new DatabaseSync(copy);
    try{db.exec('PRAGMA query_only=1');db.prepare('SELECT count(*) FROM sqlite_schema').get();}
    catch(e){fail('sqlite',new BackupError('NOT_SQLITE',`restored copy cannot be opened as SQLite: ${e.message}`));}
    checks.sqlite='ok';

    let integrity;
    try{integrity=integrityRows(db,`integrity_check(${DETAIL_LIMIT})`);}
    catch(e){fail('integrity',new BackupError('INTEGRITY_FAILED',`integrity_check could not complete: ${e.message}`));}
    if(integrity.length!==1||integrity[0]!=='ok')fail('integrity',new BackupError('INTEGRITY_FAILED',`integrity_check reported ${integrity.length} problem(s): ${integrity.slice(0,3).join('; ')}`,integrity));
    checks.integrity='ok';

    const userVersion=db.prepare('PRAGMA user_version').get().user_version;
    report.userVersion=userVersion;
    if(!inSchemaRange(userVersion))fail('schemaVersion',schemaRangeError(userVersion));
    if(userVersion!==man.userVersion)fail('schemaVersion',new BackupError('SCHEMA_UNSUPPORTED',`schema version ${userVersion} does not match the manifest (${man.userVersion})`));
    const tableNames=listTables(db);
    const missing=REQUIRED_TABLES.filter(t=>!tableNames.includes(t));
    if(missing.length)fail('schemaVersion',new BackupError('SCHEMA_UNSUPPORTED',`schema version ${userVersion} is missing required tables: ${missing.join(', ')}`));
    checks.schemaVersion='ok';

    const fk=db.prepare(`PRAGMA foreign_key_check`).all().slice(0,DETAIL_LIMIT).map(r=>({table:r.table,rowid:r.rowid,parent:r.parent}));
    if(fk.length)fail('foreignKeys',new BackupError('FOREIGN_KEY_VIOLATION',`foreign_key_check found violations: ${fk.map(r=>`${r.table} rowid ${r.rowid} -> ${r.parent}`).join(', ')}`,fk));
    checks.foreignKeys='ok';

    // The schema has no FK on drafts.current_revision_id and does not tie a review's revision to its draft.
    const badDrafts=db.prepare(`SELECT d.id AS draftId,d.current_revision_id AS revisionId FROM drafts d LEFT JOIN draft_revisions r ON r.id=d.current_revision_id
      WHERE d.current_revision_id IS NOT NULL AND (r.id IS NULL OR r.draft_id<>d.id) ORDER BY d.id LIMIT ${DETAIL_LIMIT}`).all();
    if(badDrafts.length)fail('drafts',new BackupError('REFERENTIAL_MISMATCH',`drafts whose current revision is missing or belongs to another draft: ${badDrafts.map(r=>`draft ${r.draftId} -> revision ${r.revisionId}`).join(', ')}`,badDrafts.map(r=>({...r}))));
    checks.drafts='ok';
    const badReviews=db.prepare(`SELECT rd.id AS reviewId,rd.draft_id AS draftId,rd.revision_id AS revisionId FROM review_decisions rd LEFT JOIN draft_revisions r ON r.id=rd.revision_id
      WHERE r.id IS NULL OR r.draft_id<>rd.draft_id ORDER BY rd.id LIMIT ${DETAIL_LIMIT}`).all();
    if(badReviews.length)fail('reviews',new BackupError('REFERENTIAL_MISMATCH',`review decisions whose revision is missing or belongs to another draft: ${badReviews.map(r=>`review ${r.reviewId} (draft ${r.draftId}) -> revision ${r.revisionId}`).join(', ')}`,badReviews.map(r=>({...r}))));
    checks.reviews='ok';
    const badNumbers=db.prepare(`SELECT id AS revisionId,draft_id AS draftId FROM draft_revisions WHERE typeof(revision_number)<>'integer' OR revision_number<1
      UNION ALL SELECT min(id),draft_id FROM draft_revisions GROUP BY draft_id,revision_number HAVING count(*)>1 LIMIT ${DETAIL_LIMIT}`).all();
    if(badNumbers.length)fail('revisionNumbers',new BackupError('REFERENTIAL_MISMATCH',`revisions with an invalid or duplicate revision_number: ${badNumbers.map(r=>`revision ${r.revisionId} (draft ${r.draftId})`).join(', ')}`,badNumbers.map(r=>({...r}))));
    checks.revisionNumbers='ok';

    const tables=countRows(db,tableNames);
    report.tables=tables;
    const names=new Set([...Object.keys(tables),...Object.keys(man.tables)]);
    const diffs=[...names].filter(n=>tables[n]!==man.tables[n]).map(n=>({table:n,expected:man.tables[n]??null,found:tables[n]??null}));
    if(diffs.length)fail('rowCounts',new BackupError('ROWCOUNT_MISMATCH',`row counts differ from the manifest: ${diffs.map(d=>`${d.table} expected ${d.expected} found ${d.found}`).join(', ')}`,diffs));
    checks.rowCounts='ok';

    // Ids, numbers and statuses only: no wallet addresses, questions or session hashes.
    report.sample={drafts:db.prepare(`SELECT d.id,d.status,r.revision_number AS currentRevisionNumber,
      (SELECT count(*) FROM draft_revisions x WHERE x.draft_id=d.id) AS revisions,
      (SELECT count(*) FROM review_decisions y WHERE y.draft_id=d.id) AS decisions
      FROM drafts d LEFT JOIN draft_revisions r ON r.id=d.current_revision_id ORDER BY d.id DESC LIMIT 5`).all().map(r=>({...r}))};
    db.close();db=undefined;
    report.ok=true;
    report.verifiedAt=now().toISOString();
    await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
    return {report,target,database:copy,reportPath};
  }catch(e){
    if(db)db.close();
    for(const k of Object.keys(checks))if(checks[k]==='pending')checks[k]='skipped';
    report.ok=false;
    report.verifiedAt=now().toISOString();
    report.error={code:e.code??'VERIFY_FAILED',message:e.message};
    try{await writeFile(reportPath,JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});}catch{/* the original error matters more */}
    if(e instanceof BackupError)throw e;
    throw new BackupError('VERIFY_FAILED',`restore verification failed: ${e.message}`);
  }
}

/** Resolves {up:true} when something answers on the health endpoint; only a refused connection counts as down. */
export function defaultProbe(port,{timeoutMs=1000}={}){
  return new Promise(resolvePromise=>{
    let settled=false;
    const done=result=>{if(!settled){settled=true;resolvePromise(result);}};
    const req=request({host:'127.0.0.1',port,path:'/api/health',method:'GET',timeout:timeoutMs},res=>{res.resume();done({up:true,detail:`HTTP ${res.statusCode}`});req.destroy();});
    req.on('timeout',()=>{done({up:true,detail:'health probe timed out; treating the API as running'});req.destroy();});
    req.on('error',e=>done(e.code==='ECONNREFUSED'?{up:false,detail:'connection refused'}:{up:true,detail:`health probe inconclusive (${e.code||e.message}); treating the API as running`}));
    req.end();
  });
}

// Opens the active database and takes an exclusive lock with no wait. Fails if any other connection is open,
// including an idle connection held by a running API. Returns the open connection, holding the lock.
function exclusiveLockProbe(file){
  const db=new DatabaseSync(file);
  try{db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT');return db;}
  catch(e){
    db.close();
    if(/locked|busy/i.test(e.message))throw new BackupError('DATABASE_IN_USE',`active database ${file} is open in another process; stop the API before promoting`);
    if(/not a database|malformed|corrupt/i.test(e.message))throw new BackupError('ACTIVE_NOT_SQLITE',`active database ${file} cannot be opened (${e.message}); with the API stopped, move it and any -wal/-shm files aside by hand, then promote again`);
    throw new BackupError('DATABASE_IN_USE',`could not take an exclusive lock on ${file}: ${e.message}`);
  }
}

/**
 * Install a verified restore as the active database. Requires a passing verify-report.json whose hash still
 * matches, a stopped API (health probe refused) and no other open connection (exclusive lock probe).
 * On any failure after a change was made, the original files are moved back and PROMOTE_FAILED_ROLLED_BACK is thrown.
 */
export async function promoteRestore({target,active,port=3001,now=()=>new Date(),probeHealth=defaultProbe,onLog=()=>{},_failAfterStep}={}){
  if(typeof target!=='string'||!target)throw new BackupError('TARGET_REQUIRED','no verified target directory given');
  if(typeof active!=='string'||!active)throw new BackupError('ACTIVE_REQUIRED','no active database path given');
  target=resolve(target);active=resolve(active);
  const verified=join(target,'revmarket.sqlite');
  let report;
  try{report=JSON.parse(await readFile(join(target,'verify-report.json'),'utf8'));}
  catch{throw new BackupError('NOT_VERIFIED',`${target} has no readable verify-report.json; run restore verification first`);}
  if(!report||report.ok!==true||typeof report.sha256!=='string')throw new BackupError('NOT_VERIFIED',`${target} did not pass restore verification`);
  let currentHash;
  try{currentHash=await sha256File(verified);}
  catch(e){if(e.code==='ENOENT')throw new BackupError('NOT_VERIFIED',`${verified} is missing`);throw e;}
  if(currentHash!==report.sha256)throw new BackupError('HASH_MISMATCH',`${verified} changed after verification (sha256 ${currentHash}, verified ${report.sha256})`);
  if(!inSchemaRange(report.userVersion))throw schemaRangeError(report.userVersion);
  try{if(!(await stat(dirname(active))).isDirectory())throw new Error();}
  catch{throw new BackupError('ACTIVE_DIR_NOT_FOUND',`directory ${dirname(active)} does not exist`);}
  const restoring=active+'.restoring';
  if(await exists(restoring))throw new BackupError('RESTORE_IN_PROGRESS',`${restoring} exists from an earlier attempt; inspect and remove it first`);

  const health=await probeHealth(port);
  if(health?.up)throw new BackupError('API_RUNNING',`the API answers on port ${port} (${health.detail??'up'}); stop it before promoting`);

  const activeExists=await exists(active);
  if(!activeExists)onLog(`no active database at ${active}; the lock probe and checkpoint are skipped`);
  const ts=fileTimestamp(now());
  const timingsMs={};
  const started=performance.now();
  const moved=[];
  let installed=false,restoringCreated=false,moveDone=false,lockDb;
  const step=async(name,fn)=>{
    const t=performance.now();
    await fn();
    timingsMs[name]=Math.round((performance.now()-t)*100)/100;
    if(_failAfterStep===name)throw new Error(`injected failure after ${name}`);
  };
  if(activeExists)lockDb=exclusiveLockProbe(active);
  try{
    await step('checkpoint',async()=>{
      if(lockDb){
        try{
          const result=lockDb.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
          if(result&&result.busy!==0)throw new Error('WAL checkpoint reported busy');
        }finally{lockDb.close();lockDb=undefined;}
      }
    });
    await step('move',async()=>{
      for(const suffix of ['',...SIDECARS]){
        const from=active+suffix;
        if(!await exists(from))continue;
        const to=`${from}.pre-restore-${ts}`;
        if(await exists(to))throw new Error(`${to} already exists`);
        await rename(from,to);
        moved.push({from,to});
      }
      moveDone=true;
    });
    await step('install',async()=>{
      restoringCreated=true;
      try{await copyFile(verified,restoring,fsConstants.COPYFILE_EXCL);}
      catch(copyError){if(copyError.code==='EEXIST')restoringCreated=false;throw copyError;}
      const handle=await open(restoring,'r+');
      try{await handle.sync();}finally{await handle.close();}
      if(await exists(active))throw new Error(`${active} reappeared during promotion; is the API starting?`);
      await rename(restoring,active);
      restoringCreated=false;installed=true;
    });
    await step('postCheck',async()=>{
      const db=new DatabaseSync(active);
      let quick,version;
      try{db.exec('PRAGMA query_only=1');quick=integrityRows(db,'quick_check');version=db.prepare('PRAGMA user_version').get().user_version;}
      finally{db.close();}
      if(quick.length!==1||quick[0]!=='ok')throw new Error(`quick_check failed on the installed database: ${quick.slice(0,3).join('; ')}`);
      if(version!==report.userVersion)throw new Error(`installed schema version ${version} differs from the verified ${report.userVersion}`);
      const installedHash=await sha256File(active);
      if(installedHash!==report.sha256)throw new Error(`installed database hash ${installedHash} differs from the verified ${report.sha256}`);
    });
  }catch(e){
    if(lockDb){try{lockDb.close();}catch{}lockDb=undefined;}
    const problems=[];
    try{
      if(restoringCreated)await rm(restoring,{force:true});
      if(installed)await rm(active,{force:true});
      // After a completed move, any sidecar at the active path was created by the restored copy, not the original.
      if(moveDone)for(const suffix of SIDECARS)await rm(active+suffix,{force:true});
    }catch(cleanupError){problems.push(cleanupError.message);}
    for(const {from,to} of [...moved].reverse()){
      try{await rename(to,from);}catch(renameError){problems.push(`could not move ${to} back to ${from}: ${renameError.message}`);}
    }
    if(problems.length)throw new BackupError('PROMOTE_ROLLBACK_INCOMPLETE',`promotion failed (${e.message}) and automatic rollback was incomplete: ${problems.join('; ')}. Keep the API stopped and move the .pre-restore-${ts} files back by hand.`,{preRestore:moved.map(m=>m.to)});
    throw new BackupError('PROMOTE_FAILED_ROLLED_BACK',`promotion failed and the original database was put back: ${e.message}`);
  }
  timingsMs.total=Math.round((performance.now()-started)*100)/100;
  const preRestore=moved.map(m=>m.to);
  return {active,timingsMs,preRestore,rollback:moved.map(m=>({from:m.to,to:m.from})),healthProbe:health?.detail??'down',lockProbe:activeExists?'exclusive lock acquired':'skipped (no active database)'};
}
