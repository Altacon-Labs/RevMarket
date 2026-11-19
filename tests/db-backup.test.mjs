import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {copyFile,mkdir,mkdtemp,readdir,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../backend/store.mjs';
import {BackupError,createBackup,defaultProbe,promoteRestore,supportedSchemaVersion,verifyRestore} from '../backend/backup.mjs';
import {seedFixture} from '../scripts/db-fixture.mjs';

const repo=fileURLToPath(new URL('../',import.meta.url));
const writerScript=join(repo,'scripts','db-writer.mjs');
const down=async()=>({up:false,detail:'stubbed down'});
const sha=buf=>createHash('sha256').update(buf).digest('hex');
const fileSha=async file=>sha(await readFile(file));
const S=supportedSchemaVersion();
// Derived from store.mjs so the tests keep passing when a newer schema migration lands.
const BACKUP_NAME=new RegExp(String.raw`^revmarket-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-v${S}\.sqlite$`);

async function tempDir(t){
  const dir=await mkdtemp(join(tmpdir(),'revmarket-backup-'));
  t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:50}));
  return dir;
}
function seed(file,drafts=30){
  const db=openStore(file);
  try{seedFixture(db,{drafts});}finally{db.close();}
}
function query(file,fn){
  const db=new DatabaseSync(file);
  try{return fn(db);}finally{db.close();}
}
const countOf=(file,table)=>query(file,db=>db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
function allCounts(file){
  return query(file,db=>Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({name})=>[name,db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n])));
}
// Byte snapshot of a database and its sidecars (null when a file does not exist).
async function snapshot(file){
  const out={};
  for(const s of ['','-wal','-shm','-journal'])out[s||'main']=existsSync(file+s)?await fileSha(file+s):null;
  return out;
}
async function expectCode(promise,code){
  await assert.rejects(promise,e=>{
    assert.ok(e instanceof BackupError,`expected BackupError, got ${e}`);
    if(Array.isArray(code))assert.ok(code.includes(e.code),`expected ${code.join('|')}, got ${e.code}: ${e.message}`);
    else assert.equal(e.code,code,e.message);
    return true;
  });
}

function startChild(t,args){
  const child=spawn(process.execPath,['--experimental-sqlite',writerScript,...args],{stdio:['pipe','pipe','pipe']});
  const exited=new Promise(r=>child.once('exit',r));
  const state={committed:0,ready:false,stderr:'',child,exited};
  let buf='';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',d=>{buf+=d;const m=[...buf.matchAll(/(?:committed|done) (\d+)/g)].pop();if(m)state.committed=Number(m[1]);if(buf.includes('ready'))state.ready=true;buf=buf.slice(-64);});
  child.stderr.on('data',d=>{state.stderr+=d;});
  state.waitFor=async(pred,label)=>{
    const until=Date.now()+15000;
    while(!pred()){
      if(child.exitCode!==null)throw new Error(`helper exited early (${label}): ${state.stderr}`);
      if(Date.now()>until)throw new Error(`timed out waiting for ${label}`);
      await new Promise(r=>setTimeout(r,5));
    }
  };
  state.stop=async()=>{if(child.exitCode===null){child.stdin.write('stop\n');child.stdin.end();}await exited;};
  t.after(async()=>{if(child.exitCode===null)child.kill();await exited;});
  return state;
}

// A seeded live database plus one verified-good backup of it.
async function fixtureWithBackup(t,{drafts=30}={}){
  const dir=await tempDir(t);
  const live=join(dir,'live.sqlite');
  seed(live,drafts);
  await mkdir(join(dir,'backups'));
  const backup=await createBackup({source:live,outDir:join(dir,'backups')});
  return {dir,live,...backup};
}

// Copy a backup, change the copy, and write a manifest that is consistent with the changed copy
// (fresh sha256 and row counts) unless mutateManifest overrides it.
async function tamperedBackup(f,name,{mutateDb,mutateBytes,mutateManifest}={}){
  const dir=join(f.dir,name);await mkdir(dir);
  const file=join(dir,'tampered.sqlite');
  await copyFile(f.backupPath,file);
  if(mutateDb)query(file,db=>{db.exec('PRAGMA foreign_keys=OFF');mutateDb(db);});
  if(mutateBytes){const b=await readFile(file);mutateBytes(b);await writeFile(file,b);}
  let tables=f.manifest.tables;
  try{tables=allCounts(file);}catch{/* unreadable on purpose */}
  const userVersion=(()=>{try{return query(file,db=>db.prepare('PRAGMA user_version').get().user_version);}catch{return f.manifest.userVersion;}})();
  let manifest={...f.manifest,file:'tampered.sqlite',sha256:await fileSha(file),tables,userVersion};
  if(mutateManifest)manifest=mutateManifest(manifest);
  await writeFile(join(dir,'tampered.manifest.json'),JSON.stringify(manifest));
  return {file,dir};
}

test('schema range comes from openStore migrations, not a hard-coded version',()=>{
  const db=openStore(':memory:');
  try{assert.equal(supportedSchemaVersion(),db.prepare('PRAGMA user_version').get().user_version);}finally{db.close();}
  assert.ok(supportedSchemaVersion()>=2);
});

test('AC1: backup taken while a separate writer process commits is a consistent point-in-time snapshot',async t=>{
  const dir=await tempDir(t);
  const live=join(dir,'live.sqlite');
  const seeded=1500;
  seed(live,seeded);
  const out=join(dir,'backups');await mkdir(out);
  const writer=startChild(t,[live]);
  await writer.waitFor(()=>writer.committed>=50,'50 writer commits');
  assert.ok(existsSync(live+'-wal'),'live database is in WAL mode with a -wal file while the writer runs');
  const before=writer.committed;
  const {manifest,backupPath,manifestPath}=await createBackup({source:live,outDir:out});
  const afterBackup=writer.committed;
  await writer.waitFor(()=>writer.committed>=afterBackup+20,'writer to keep committing after the backup');
  await writer.stop();
  t.diagnostic(`writer commits: ${before} before backup, ${afterBackup-before} during, ${writer.committed} total`);

  assert.match(manifest.file,BACKUP_NAME);
  assert.equal(manifestPath,backupPath.replace(/\.sqlite$/,'.manifest.json'));
  assert.deepEqual((await readdir(out)).sort(),[manifest.file,manifest.file.replace(/\.sqlite$/,'.manifest.json')].sort(),'no .partial files remain');
  assert.equal(manifest.method,'VACUUM INTO');
  assert.equal(manifest.userVersion,S);
  assert.equal(manifest.sha256,await fileSha(backupPath));
  assert.deepEqual(JSON.parse(await readFile(manifestPath,'utf8')),manifest);

  query(backupPath,db=>{
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(r=>r.integrity_check),['ok']);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    const orphans=db.prepare(`SELECT count(*) AS n FROM drafts d LEFT JOIN draft_revisions r ON r.id=d.current_revision_id
      WHERE r.id IS NULL OR r.draft_id<>d.id`).get().n;
    assert.equal(orphans,0,'every draft has a same-draft current revision');
  });
  assert.deepEqual(allCounts(backupPath),manifest.tables,'manifest counts are the backup file counts');
  assert.ok(manifest.tables.drafts>=seeded+before,'snapshot includes commits made before the backup started');
  assert.ok(countOf(live,'drafts')>manifest.tables.drafts,'live database kept growing after the snapshot');
});

test('AC1: backup refuses a missing or non-SQLite source and never overwrites an existing backup',async t=>{
  const dir=await tempDir(t);
  const out=join(dir,'out');await mkdir(out);
  const missing=join(dir,'missing.sqlite');
  await expectCode(createBackup({source:missing,outDir:out}),'SOURCE_NOT_FOUND');
  assert.equal(existsSync(missing),false,'no database is created for a missing source');
  await expectCode(createBackup({source:missing,outDir:join(dir,'nope')}),'SOURCE_NOT_FOUND');
  const text=join(dir,'notes.sqlite');await writeFile(text,'this is not a database, just text padding'.repeat(20));
  await expectCode(createBackup({source:text,outDir:out}),'SOURCE_NOT_SQLITE');
  const live=join(dir,'live.sqlite');seed(live,5);
  await expectCode(createBackup({source:live,outDir:join(dir,'nope')}),'OUT_DIR_NOT_FOUND');
  assert.deepEqual(await readdir(out),[]);

  const now=()=>new Date('2026-11-19T10:22:05.000Z');
  const first=await createBackup({source:live,outDir:out,now});
  assert.equal(first.manifest.file,`revmarket-2026-11-19T10-22-05Z-v${S}.sqlite`);
  const bytes=await readFile(first.backupPath),manifestBytes=await readFile(first.manifestPath);
  query(live,db=>db.exec("INSERT INTO users VALUES('GEXTRA',1,1)"));
  await expectCode(createBackup({source:live,outDir:out,now}),'BACKUP_EXISTS');
  assert.deepEqual(await readFile(first.backupPath),bytes);
  assert.deepEqual(await readFile(first.manifestPath),manifestBytes);
  assert.equal((await readdir(out)).length,2,'no partial or extra files after a refused backup');
});

test('AC2: restore into a clean location validates and reports without personal data',async t=>{
  const f=await fixtureWithBackup(t);
  const liveBefore=await snapshot(f.live);
  const target=join(f.dir,'restore');
  const {report,database,reportPath}=await verifyRestore({backup:f.backupPath,target});
  assert.equal(report.ok,true);
  assert.deepEqual(Object.keys(report.checks).sort(),['drafts','foreignKeys','hash','integrity','reviews','revisionNumbers','rowCounts','schemaVersion','sqlite']);
  assert.ok(Object.values(report.checks).every(v=>v==='ok'));
  assert.equal(report.sha256,f.manifest.sha256);
  assert.equal(await fileSha(database),f.manifest.sha256);
  assert.equal(report.userVersion,S);
  assert.deepEqual(report.tables,f.manifest.tables);
  assert.ok(report.sample.drafts.length>0&&report.sample.drafts.length<=5);
  for(const d of report.sample.drafts)assert.deepEqual(Object.keys(d).sort(),['currentRevisionNumber','decisions','id','revisions','status']);
  const text=await readFile(reportPath,'utf8');
  assert.deepEqual(JSON.parse(text),report);
  assert.doesNotMatch(text,/GFIXTURE|Fixture question|wallet/i,'report has no wallets or questions');
  assert.deepEqual(await snapshot(f.live),liveBefore);
});

test('AC2: an existing target directory is refused and left untouched',async t=>{
  const f=await fixtureWithBackup(t);
  const empty=join(f.dir,'empty');await mkdir(empty);
  await expectCode(verifyRestore({backup:f.backupPath,target:empty}),'TARGET_EXISTS');
  assert.deepEqual(await readdir(empty),[]);
  const used=join(f.dir,'used');await mkdir(used);await writeFile(join(used,'revmarket.sqlite'),'keep me');
  await expectCode(verifyRestore({backup:f.backupPath,target:used}),'TARGET_EXISTS');
  assert.deepEqual(await readdir(used),['revmarket.sqlite']);
  assert.equal(await readFile(join(used,'revmarket.sqlite'),'utf8'),'keep me');
  await expectCode(verifyRestore({backup:f.backupPath,target:join(f.dir,'missing-parent','t')}),'TARGET_PARENT_NOT_FOUND');
  await expectCode(verifyRestore({backup:f.backupPath,manifest:join(f.dir,'none.json'),target:join(f.dir,'t2')}),'MANIFEST_NOT_FOUND');
  assert.equal(existsSync(join(f.dir,'t2')),false,'no target is created when the manifest is missing');
});

const otherDraftRevision=db=>db.prepare('SELECT r.id FROM draft_revisions r JOIN drafts d ON d.id=1 WHERE r.draft_id<>1 LIMIT 1').get().id;
const failureCases=[
  {name:'flipped byte (manifest unchanged)',code:'HASH_MISMATCH',raw:true,mutateBytes:b=>{b[Math.floor(b.length/2)]^=0x01;}},
  {name:'corrupted b-tree page (manifest hash recomputed)',code:['INTEGRITY_FAILED','NOT_SQLITE'],mutateBytes:b=>{const ps=b.readUInt16BE(16);b.fill(0xff,ps*2,ps*2+64);}},
  {name:'overwritten SQLite header (manifest hash recomputed)',code:'NOT_SQLITE',mutateBytes:b=>{b.fill(0,0,16);}},
  {name:'user_version 99',code:'SCHEMA_UNSUPPORTED',mutateDb:db=>db.exec('PRAGMA user_version=99')},
  {name:'user_version 0',code:'SCHEMA_UNSUPPORTED',mutateDb:db=>db.exec('PRAGMA user_version=0')},
  {name:'user_version 1',code:'SCHEMA_UNSUPPORTED',mutateDb:db=>db.exec('PRAGMA user_version=1')},
  {name:'foreign key violation',code:'FOREIGN_KEY_VIOLATION',mutateDb:db=>db.exec("INSERT INTO draft_revisions(draft_id,revision_number,question,trading_close,content_hash,created_at) VALUES(999999,1,'x',1,'h',1)")},
  {name:'draft points at another draft revision',code:'REFERENTIAL_MISMATCH',mutateDb:db=>db.prepare('UPDATE drafts SET current_revision_id=? WHERE id=1').run(otherDraftRevision(db))},
  {name:'draft points at a missing revision',code:'REFERENTIAL_MISMATCH',mutateDb:db=>db.exec('UPDATE drafts SET current_revision_id=987654 WHERE id=1')},
  {name:'review revision belongs to another draft',code:'REFERENTIAL_MISMATCH',mutateDb:db=>{
    const review=db.prepare('SELECT id,draft_id FROM review_decisions LIMIT 1').get();
    const rev=db.prepare('SELECT id FROM draft_revisions WHERE draft_id<>? LIMIT 1').get(review.draft_id).id;
    db.prepare('UPDATE review_decisions SET revision_id=? WHERE id=?').run(rev,review.id);
  }},
  {name:'revision number below 1',code:'REFERENTIAL_MISMATCH',mutateDb:db=>db.exec('UPDATE draft_revisions SET revision_number=0 WHERE id=(SELECT min(id) FROM draft_revisions)')},
  {name:'manifest row count off by one',code:'ROWCOUNT_MISMATCH',mutateManifest:m=>({...m,tables:{...m.tables,drafts:m.tables.drafts+1}})},
  {name:'manifest names a table the backup lacks',code:'ROWCOUNT_MISMATCH',mutateManifest:m=>({...m,tables:{...m.tables,ghost:0}})},
  {name:'manifest schema version differs',code:'SCHEMA_UNSUPPORTED',mutateManifest:m=>({...m,userVersion:m.userVersion+1})},
];
for(const c of failureCases){
  test(`AC2/AC3: ${c.name} fails with ${[c.code].flat().join(' or ')}, writes an ok:false report and leaves the live database unchanged`,async t=>{
    const f=await fixtureWithBackup(t);
    const liveBefore=await snapshot(f.live);
    let file;
    if(c.raw){
      const dir=join(f.dir,'raw');await mkdir(dir);file=join(dir,'raw.sqlite');
      const b=await readFile(f.backupPath);c.mutateBytes(b);await writeFile(file,b);
      await copyFile(f.manifestPath,join(dir,'raw.manifest.json'));
    }else{
      ({file}=await tamperedBackup(f,'tampered',c));
    }
    const target=join(f.dir,'restore');
    await expectCode(verifyRestore({backup:file,target}),c.code);
    const report=JSON.parse(await readFile(join(target,'verify-report.json'),'utf8'));
    assert.equal(report.ok,false);
    assert.ok([c.code].flat().includes(report.error.code));
    assert.ok(Object.values(report.checks).includes('failed'));
    assert.deepEqual(await snapshot(f.live),liveBefore,'live database is byte-identical');
    await expectCode(promoteRestore({target,active:f.live,probeHealth:down}),'NOT_VERIFIED');
    assert.deepEqual(await snapshot(f.live),liveBefore,'a failed verification can never be promoted');
  });
}

// An active database left by a crashed API: committed transactions still in a non-empty -wal and a stale -shm.
async function crashedActive(t,dir,{drafts=20,commits=15}={}){
  const active=join(dir,'active','revmarket.sqlite');
  await mkdir(join(dir,'active'));
  seed(active,drafts);
  const crash=startChild(t,[active,'--crash',String(commits)]);
  await crash.exited;
  assert.equal(crash.child.exitCode,0,crash.stderr);
  assert.ok(existsSync(active+'-wal')&&existsSync(active+'-shm'),'crashed writer left -wal and -shm');
  return active;
}
async function verifiedTarget(f,name='verified'){
  const target=join(f.dir,name);
  await verifyRestore({backup:f.backupPath,target});
  return target;
}

test('AC3: promote refuses unverified, changed, API-running and in-use cases and leaves the active files byte-identical',async t=>{
  const f=await fixtureWithBackup(t);
  const active=await crashedActive(t,f.dir);
  const original=await snapshot(active);
  assert.ok(original['-wal']&&original['-shm']);

  const nothing=join(f.dir,'not-verified');await mkdir(nothing);
  await copyFile(f.backupPath,join(nothing,'revmarket.sqlite'));
  await expectCode(promoteRestore({target:nothing,active,probeHealth:down}),'NOT_VERIFIED');
  await writeFile(join(nothing,'verify-report.json'),JSON.stringify({ok:false,sha256:f.manifest.sha256}));
  await expectCode(promoteRestore({target:nothing,active,probeHealth:down}),'NOT_VERIFIED');

  const changed=await verifiedTarget(f,'changed');
  const bytes=await readFile(join(changed,'revmarket.sqlite'));bytes[bytes.length-1]^=0x01;
  await writeFile(join(changed,'revmarket.sqlite'),bytes);
  await expectCode(promoteRestore({target:changed,active,probeHealth:down}),'HASH_MISMATCH');

  const target=await verifiedTarget(f);
  await expectCode(promoteRestore({target,active,probeHealth:async()=>({up:true,detail:'HTTP 200'})}),'API_RUNNING');
  const server=createServer((req,res)=>res.end('{"status":"ok"}'));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  await expectCode(promoteRestore({target,active,port:server.address().port}),'API_RUNNING');
  assert.deepEqual(await snapshot(active),original,'active, -wal and -shm unchanged by refused promotes');

  const holder=startChild(t,[active,'--hold']);
  await holder.waitFor(()=>holder.ready,'holder ready');
  const held=await snapshot(active);
  await expectCode(promoteRestore({target,active,probeHealth:down}),'DATABASE_IN_USE');
  assert.deepEqual(await snapshot(active),held,'active files unchanged when another process holds the database');
  assert.equal(existsSync(active+'.restoring'),false);
  assert.deepEqual((await readdir(join(f.dir,'active'))).filter(n=>n.includes('pre-restore')),[]);
  await holder.stop();
});

for(const step of ['move','install','postCheck']){
  test(`AC3: a failure after the ${step} step rolls back to the exact original active bytes`,async t=>{
    const f=await fixtureWithBackup(t);
    const active=join(f.dir,'active.sqlite');
    seed(active,12);
    const original=await snapshot(active);
    const target=await verifiedTarget(f);
    await expectCode(promoteRestore({target,active,probeHealth:down,_failAfterStep:step}),'PROMOTE_FAILED_ROLLED_BACK');
    assert.deepEqual(await snapshot(active),original);
    const names=await readdir(f.dir);
    assert.deepEqual(names.filter(n=>n.includes('.restoring')||n.includes('pre-restore')),[]);
    assert.equal(await fileSha(join(target,'revmarket.sqlite')),f.manifest.sha256,'verified copy is untouched');
  });
}

test('AC3: rollback after a failed install keeps every committed row of a crashed active database',async t=>{
  const f=await fixtureWithBackup(t);
  const active=await crashedActive(t,f.dir,{drafts:20,commits:15});
  const copyDir=join(f.dir,'expected');await mkdir(copyDir);
  for(const s of ['','-wal','-shm'])await copyFile(active+s,join(copyDir,'revmarket.sqlite'+s));
  const expected=allCounts(join(copyDir,'revmarket.sqlite'));
  assert.equal(expected.drafts,35);
  const target=await verifiedTarget(f);
  await expectCode(promoteRestore({target,active,probeHealth:down,_failAfterStep:'install'}),'PROMOTE_FAILED_ROLLED_BACK');
  assert.deepEqual(allCounts(active),expected,'committed WAL transactions survive the rollback');
  assert.deepEqual((await readdir(join(f.dir,'active'))).filter(n=>n.includes('.restoring')||n.includes('pre-restore')),[]);
});

test('AC3: promote onto a crashed active database with a non-empty -wal installs the backup and keeps the original',async t=>{
  const f=await fixtureWithBackup(t,{drafts:30});
  const active=await crashedActive(t,f.dir,{drafts:20,commits:15});
  const copyDir=join(f.dir,'expected');await mkdir(copyDir);
  for(const s of ['','-wal','-shm'])await copyFile(active+s,join(copyDir,'revmarket.sqlite'+s));
  const expected=allCounts(join(copyDir,'revmarket.sqlite'));
  const target=await verifiedTarget(f);
  const result=await promoteRestore({target,active,probeHealth:down,now:()=>new Date('2026-11-19T12:00:00Z')});

  for(const k of ['checkpoint','move','install','postCheck','total'])assert.equal(typeof result.timingsMs[k],'number');
  assert.equal(result.lockProbe,'exclusive lock acquired');
  assert.ok(result.preRestore.includes(active+'.pre-restore-2026-11-19T12-00-00Z'));
  assert.equal(await fileSha(active),f.manifest.sha256,'installed file is the verified backup');
  assert.equal(existsSync(active+'-wal'),false,'no stale WAL can be replayed onto the restored file');
  assert.equal(existsSync(active+'-shm'),false);
  const db=openStore(active);db.close();
  assert.deepEqual(allCounts(active),f.manifest.tables);

  // The preserved original holds every committed row, including those that were only in the -wal.
  const preserved=join(f.dir,'preserved.sqlite');
  await copyFile(active+'.pre-restore-2026-11-19T12-00-00Z',preserved);
  assert.deepEqual(allCounts(preserved),expected);

  // Manual rollback: move the restored file aside, move the .pre-restore files back.
  for(const s of ['','-wal','-shm'])if(existsSync(active+s))await rename(active+s,active+s+'.rolled-back');
  for(const {from,to} of result.rollback)await rename(from,to);
  assert.deepEqual(allCounts(active),expected);
});

test('AC3: promote onto a cleanly closed active database preserves it byte for byte',async t=>{
  const f=await fixtureWithBackup(t);
  const active=join(f.dir,'active.sqlite');
  seed(active,8);
  const original=await fileSha(active);
  const target=await verifiedTarget(f);
  const result=await promoteRestore({target,active,probeHealth:down});
  assert.equal(result.preRestore.length,1);
  assert.equal(await fileSha(result.preRestore[0]),original);
  assert.equal(await fileSha(active),f.manifest.sha256);
  await rm(active);
  for(const {from,to} of result.rollback)await rename(from,to);
  assert.equal(await fileSha(active),original);
});

test('promote with no previous active database installs the verified copy',async t=>{
  const f=await fixtureWithBackup(t);
  const active=join(f.dir,'fresh','revmarket.sqlite');await mkdir(join(f.dir,'fresh'));
  const logs=[];
  const result=await promoteRestore({target:await verifiedTarget(f),active,probeHealth:down,onLog:m=>logs.push(m)});
  assert.deepEqual(result.preRestore,[]);
  assert.match(result.lockProbe,/skipped/);
  assert.match(logs.join('\n'),/lock probe and checkpoint are skipped/);
  assert.equal(await fileSha(active),f.manifest.sha256);
  await expectCode(promoteRestore({target:await verifiedTarget(f,'v2'),active:join(f.dir,'missing-dir','db.sqlite'),probeHealth:down}),'ACTIVE_DIR_NOT_FOUND');
});

test('AC3: promote refuses a corrupt active file with ACTIVE_NOT_SQLITE and leaves it untouched',async t=>{
  const f=await fixtureWithBackup(t);
  const active=join(f.dir,'garbage.sqlite');
  await writeFile(active,Buffer.alloc(8192,0x5a));
  const before=await snapshot(active);
  await expectCode(promoteRestore({target:await verifiedTarget(f),active,probeHealth:down}),'ACTIVE_NOT_SQLITE');
  assert.deepEqual(await snapshot(active),before);
  assert.deepEqual((await readdir(f.dir)).filter(n=>n.includes('.restoring')||n.includes('pre-restore')),[]);
});

test('health probe reports a refused port as down and any HTTP answer as up',async t=>{
  const server=createServer((req,res)=>{res.statusCode=503;res.end();});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port=server.address().port;
  assert.equal((await defaultProbe(port)).up,true);
  await new Promise(r=>server.close(r));
  assert.equal((await defaultProbe(port)).up,false);
});

function runScript(script,args,env={}){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,['--experimental-sqlite',join(repo,'scripts',script),...args],{cwd:repo,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>{stderr+=d;});
    child.on('exit',code=>resolve({code,stdout,stderr}));
  });
}

test('CLI: backup, verify and promote succeed; an existing target and a running API fail with codes',async t=>{
  const dir=await tempDir(t);
  const live=join(dir,'live.sqlite');seed(live,10);
  const out=join(dir,'out');await mkdir(out);
  const usage=await runScript('db-backup.mjs',[]);
  assert.equal(usage.code,1);assert.match(usage.stderr,/db:backup failed \[USAGE\]/);

  const b=await runScript('db-backup.mjs',['--out',out],{BACKEND_DB:live});
  assert.equal(b.code,0,b.stderr);
  const summary=JSON.parse(b.stdout.trim());
  assert.equal(summary.ok,true);
  assert.match(summary.backup.split(/[\\/]/).pop(),BACKUP_NAME);
  assert.doesNotMatch(b.stdout+b.stderr,/GFIXTURE|Fixture question/);

  const target=join(dir,'restore');
  const v=await runScript('db-restore-verify.mjs',[summary.backup,'--target',target]);
  assert.equal(v.code,0,v.stderr);
  assert.equal(JSON.parse(v.stdout.trim()).ok,true);

  const again=await runScript('db-restore-verify.mjs',[summary.backup,'--target',target]);
  assert.equal(again.code,1);
  assert.match(again.stderr,/^db:restore-verify failed \[TARGET_EXISTS\]: /m);
  assert.doesNotMatch(again.stderr,/\n\s+at /,'no stack trace');

  const server=createServer((req,res)=>res.end('ok'));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const busyPort=server.address().port;
  const active=join(dir,'active.sqlite');seed(active,3);
  const activeBefore=await fileSha(active);
  const refused=await runScript('db-restore-verify.mjs',['--promote','--target',target,'--db',active,'--port',String(busyPort)]);
  assert.equal(refused.code,1);
  assert.match(refused.stderr,/\[API_RUNNING\]/);
  assert.equal(await fileSha(active),activeBefore);
  await new Promise(r=>server.close(r));

  const promoted=await runScript('db-restore-verify.mjs',['--promote','--target',target,'--db',active,'--port',String(busyPort)]);
  assert.equal(promoted.code,0,promoted.stderr);
  const result=JSON.parse(promoted.stdout.split('\n')[0]);
  assert.equal(result.ok,true);
  assert.equal(typeof result.timingsMs.total,'number');
  assert.match(promoted.stdout,/To roll back/);
  assert.match(promoted.stdout,/Move-Item -LiteralPath/);
  assert.equal(await fileSha(active),summary.sha256);
});
