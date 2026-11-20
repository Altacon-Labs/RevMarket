// Backup and restore drill on synthetic fixture data, entirely inside a new temporary directory.
// It never reads or writes backend/data. It runs the real backend (backend/server.mjs) as a child process
// against the temporary database so the API-running guards and restart time are exercised for real.
// Usage: node --experimental-sqlite scripts/db-drill.mjs [--drafts 5000] [--keep]
import {parseArgs} from 'node:util';
import {spawn} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {tmpdir,type,release,arch,cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {openStore} from '../backend/store.mjs';
import {createBackup,defaultProbe,promoteRestore,sha256File,supportedSchemaVersion,verifyRestore} from '../backend/backup.mjs';
import {seedFixture} from './db-fixture.mjs';
import {runCli,UsageError} from './db-cli.mjs';

const serverScript=fileURLToPath(new URL('../backend/server.mjs',import.meta.url));
const writerScript=fileURLToPath(new URL('./db-writer.mjs',import.meta.url));
const ms=t=>Math.round(t*100)/100;
const sleep=n=>new Promise(r=>setTimeout(r,n));

function assertDrillOutcome(result){
  const c=result.checks;
  const expect=(cond,msg)=>{if(!cond)throw new Error(`drill assertion failed: ${msg}`);};
  expect(c.flippedByte==='HASH_MISMATCH','flipped byte must be rejected with HASH_MISMATCH');
  expect(c.corruptedPage==='INTEGRITY_FAILED'||c.corruptedPage==='NOT_SQLITE','corrupted page must be rejected');
  expect(c.promoteWhileApiUp==='API_RUNNING','promote must refuse while API is running');
  expect(c.promoteWhileDbOpen==='DATABASE_IN_USE','promote must refuse while database is open');
  expect(c.liveUnchangedByRefusedPromotes===true,'live database must be unchanged by refused promotes');
  expect(c.restoredCountsMatchManifest===true,'restored row counts must match backup manifest');
  return result;
}

function freePort(){
  return new Promise((res,rej)=>{const s=createServer();s.on('error',rej);s.listen(0,'127.0.0.1',()=>{const {port}=s.address();s.close(()=>res(port));});});
}

async function startApi(db,port){
  const child=spawn(process.execPath,['--experimental-sqlite',serverScript],{env:{...process.env,BACKEND_DB:db,BACKEND_PORT:String(port)},stdio:['ignore','ignore','ignore']});
  const exited=new Promise(r=>child.once('exit',r));
  const t=performance.now();
  for(;;){
    if(child.exitCode!==null)throw new Error('backend exited during start');
    if((await defaultProbe(port,{timeoutMs:500})).up)break;
    if(performance.now()-t>20000){child.kill();throw new Error('backend did not become healthy within 20s');}
    await sleep(10);
  }
  return {child,exited,startMs:ms(performance.now()-t)};
}
async function stopApi(api){
  const t=performance.now();
  api.child.kill();
  await api.exited;
  return ms(performance.now()-t);
}

function startWriter(db){
  const child=spawn(process.execPath,['--experimental-sqlite',writerScript,db],{stdio:['pipe','pipe','ignore']});
  const state={committed:0,child,exited:new Promise(r=>child.once('exit',r))};
  let buf='';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',d=>{buf+=d;const m=[...buf.matchAll(/(?:committed|done) (\d+)/g)].pop();if(m)state.committed=Number(m[1]);buf=buf.slice(-64);});
  return state;
}

function counts(file){
  const db=new DatabaseSync(file);
  try{
    db.exec('PRAGMA query_only=1');
    return Object.fromEntries(db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({name})=>[name,Number(db.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n)]));
  }finally{db.close();}
}

async function expectCode(promise,codes){
  try{await promise;}catch(e){if(codes.includes(e.code))return e.code;throw new Error(`expected ${codes.join(' or ')}, got ${e.code}: ${e.message}`);}
  throw new Error(`expected ${codes.join(' or ')}, but the operation succeeded`);
}

await runCli('db:drill',async()=>{
  let values;
  try{({values}=parseArgs({strict:true,options:{drafts:{type:'string',default:'5000'},keep:{type:'boolean'}}}));}
  catch(e){throw new UsageError(`${e.message}. Usage: db:drill [--drafts <n>] [--keep]`);}
  const drafts=Number(values.drafts);
  if(!Number.isInteger(drafts)||drafts<1||drafts>1_000_000)throw new UsageError('--drafts must be an integer from 1 to 1000000');

  const dir=await mkdtemp(join(tmpdir(),'revmarket-drill-'));
  const live=join(dir,'live','revmarket.sqlite');
  const backups=join(dir,'backups');
  await mkdir(join(dir,'live'));await mkdir(backups);
  let api,writer;
  try{
    const t0=performance.now();
    const seedDb=openStore(live);
    try{seedFixture(seedDb,{drafts});}finally{seedDb.close();}
    const seedMs=ms(performance.now()-t0);
    const liveBytes=(await stat(live)).size;

    const port=await freePort();
    api=await startApi(live,port);
    writer=startWriter(live);
    while(writer.committed<50){if(writer.child.exitCode!==null)throw new Error('writer exited early');await sleep(5);}
    const commitsBefore=writer.committed;
    const tb=performance.now();
    const backup=await createBackup({source:live,outDir:backups});
    const backupMs=ms(performance.now()-tb);
    const commitsAfterBackup=writer.committed;
    writer.child.stdin.write('stop\n');await writer.exited;
    const writerTotal=writer.committed;writer=undefined;

    const tv=performance.now();
    const verified=await verifyRestore({backup:backup.backupPath,target:join(dir,'restore-1')});
    const verifyMs=ms(performance.now()-tv);

    // Corruption checks on copies; the live database is never involved.
    // Main file and WAL hold the data. The -shm index is excluded here because the running API rewrites it on
    // its own reads (the health probe itself); the unit tests check -shm too, with no API process attached.
    const liveFiles=async()=>Promise.all(['','-wal'].map(s=>sha256File(live+s).catch(e=>e.code==='ENOENT'?null:Promise.reject(e))));
    const liveShaBefore=JSON.stringify(await liveFiles());
    const flipped=join(dir,'corrupt-flip');await mkdir(flipped);
    const flipFile=join(flipped,'b.sqlite');await copyFile(backup.backupPath,flipFile);
    const flipBytes=await readFile(flipFile);flipBytes[Math.floor(flipBytes.length/2)]^=0xff;await writeFile(flipFile,flipBytes);
    await copyFile(backup.manifestPath,join(flipped,'b.manifest.json'));
    const flipCode=await expectCode(verifyRestore({backup:flipFile,target:join(flipped,'target')}),['HASH_MISMATCH']);
    const paged=join(dir,'corrupt-page');await mkdir(paged);
    const pageFile=join(paged,'b.sqlite');
    const pageBytes=await readFile(backup.backupPath);
    const pageSize=pageBytes.readUInt16BE(16)===1?65536:pageBytes.readUInt16BE(16);
    pageBytes.fill(0xff,pageSize*2,pageSize*2+64);await writeFile(pageFile,pageBytes);
    await writeFile(join(paged,'b.manifest.json'),JSON.stringify({...backup.manifest,sha256:await sha256File(pageFile)}));
    const pageCode=await expectCode(verifyRestore({backup:pageFile,target:join(paged,'target')}),['INTEGRITY_FAILED','NOT_SQLITE']);

    // Promote guards against the running API (real process): both probes must refuse independently.
    const apiRunningCode=await expectCode(promoteRestore({target:verified.target,active:live,port}),['API_RUNNING']);
    const inUseCode=await expectCode(promoteRestore({target:verified.target,active:live,port,probeHealth:async()=>({up:false})}),['DATABASE_IN_USE']);
    const liveUnchanged=JSON.stringify(await liveFiles())===liveShaBefore;
    if(!liveUnchanged)throw new Error('live database changed during the guarded promote attempts');

    // Cutover: stop the API, promote, start it again on the restored database.
    const apiStopMs=await stopApi(api);api=undefined;
    const promoted=await promoteRestore({target:verified.target,active:live,port});
    api=await startApi(live,port);
    const restartToHealthyMs=api.startMs;
    await stopApi(api);api=undefined;
    const after=counts(live);
    // Compare the manifest's tables only: a newer backend may migrate the restored file on start and add tables.
    const matches=Object.entries(backup.manifest.tables).every(([name,n])=>after[name]===n);
    if(!matches)throw new Error('restored active database row counts differ from the backup manifest');

    const cpu=cpus()[0]?.model?.trim()??'unknown';
    const result={
      source:'fixture',
      note:'Synthetic fixture data in a temporary directory; the API is the real backend/server.mjs as a local child process. No testnet or RPC.',
      environment:{node:process.version,os:`${type()} ${release()} ${arch()}`,cpu,cpuCount:cpus().length,memoryGiB:Math.round(totalmem()/2**30),schemaVersion:supportedSchemaVersion()},
      dataset:{drafts,seededLiveBytes:liveBytes,backupBytes:backup.manifest.bytes,tables:backup.manifest.tables},
      concurrentWriter:{commitsBeforeBackup:commitsBefore,commitsDuringBackup:commitsAfterBackup-commitsBefore,commitsTotal:writerTotal,apiRunning:true},
      timingsMs:{seed:seedMs,backup:backupMs,verify:verifyMs,promote:promoted.timingsMs,apiStop:apiStopMs,restartToHealthy:restartToHealthyMs,
        recovery:ms(verifyMs+promoted.timingsMs.total+restartToHealthyMs),cutoverDowntime:ms(apiStopMs+promoted.timingsMs.total+restartToHealthyMs)},
      checks:{verify:verified.report.checks,flippedByte:flipCode,corruptedPage:pageCode,promoteWhileApiUp:apiRunningCode,promoteWhileDbOpen:inUseCode,
        liveUnchangedByRefusedPromotes:liveUnchanged,restoredCountsMatchManifest:matches,preRestoreFiles:promoted.preRestore.length},
      definitions:{recovery:'verify + promote.total + restartToHealthy',cutoverDowntime:'apiStop + promote.total + restartToHealthy'}
    };
    assertDrillOutcome(result);
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  }finally{
    if(writer){writer.child.kill();await writer.exited;}
    if(api){api.child.kill();await api.exited;}
    if(values.keep)process.stderr.write(`db:drill: kept ${dir}\n`);
    else await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
});
