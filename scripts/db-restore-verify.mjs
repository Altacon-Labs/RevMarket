// Verify a backup by restoring it into a new directory, or promote a verified restore.
// Usage:
//   node --experimental-sqlite scripts/db-restore-verify.mjs <backup.sqlite> --target <new dir> [--manifest <file>]
//   node --experimental-sqlite scripts/db-restore-verify.mjs --promote --target <verified dir> [--db <path>] [--port <n>]
import {parseArgs} from 'node:util';
import {join} from 'node:path';
import {promoteRestore,verifyRestore} from '../backend/backup.mjs';
import {defaultDatabasePath,defaultPort,runCli,UsageError} from './db-cli.mjs';

const usage='Usage: db:restore-verify <backup.sqlite> --target <new dir> [--manifest <file>] | db:restore-verify --promote --target <verified dir> [--db <path>] [--port <n>]';
const sq=p=>`'${p.replace(/'/g,`'\''`)}'`;
const pq=p=>`'${p.replace(/'/g,"''")}'`;

function rollbackCommands(active,rollback,stamp){
  const aside=suffix=>`${active}${suffix}.rolled-back-${stamp}`;
  const posix=['','-wal','-shm'].map(s=>`[ ! -e ${sq(active+s)} ] || mv ${sq(active+s)} ${sq(aside(s))}`)
    .concat(rollback.map(r=>`mv ${sq(r.from)} ${sq(r.to)}`));
  const powershell=['','-wal','-shm'].map(s=>`if (Test-Path -LiteralPath ${pq(active+s)}) { Move-Item -LiteralPath ${pq(active+s)} -Destination ${pq(aside(s))} }`)
    .concat(rollback.map(r=>`Move-Item -LiteralPath ${pq(r.from)} -Destination ${pq(r.to)}`));
  return {posix,powershell};
}

await runCli('db:restore-verify',async()=>{
  let values,positionals;
  try{({values,positionals}=parseArgs({strict:true,allowPositionals:true,options:{target:{type:'string'},manifest:{type:'string'},promote:{type:'boolean'},db:{type:'string'},port:{type:'string'}}}));}
  catch(e){throw new UsageError(`${e.message}. ${usage}`);}
  if(!values.target)throw new UsageError(`--target is required. ${usage}`);

  if(values.promote){
    if(positionals.length||values.manifest)throw new UsageError(`--promote takes no backup file or --manifest; it installs an already verified --target. ${usage}`);
    const port=values.port!==undefined?Number(values.port):defaultPort();
    if(!Number.isInteger(port)||port<1||port>65535)throw new UsageError('--port must be an integer from 1 to 65535');
    const result=await promoteRestore({target:values.target,active:values.db??defaultDatabasePath(),port,onLog:m=>process.stderr.write(`db:restore-verify: ${m}\n`)});
    const stamp=new Date().toISOString().replace(/\.\d{3}Z$/,'Z').replace(/:/g,'-');
    const commands=rollbackCommands(result.active,result.rollback,stamp);
    process.stdout.write(JSON.stringify({ok:true,promoted:result.active,timingsMs:result.timingsMs,preRestore:result.preRestore,healthProbe:result.healthProbe,lockProbe:result.lockProbe})+'\n');
    if(result.rollback.length){
      process.stdout.write('\nTo roll back (keep the API stopped first):\n  POSIX shell:\n'+commands.posix.map(c=>'    '+c).join('\n')+'\n  PowerShell:\n'+commands.powershell.map(c=>'    '+c).join('\n')+'\n');
    }else{
      process.stdout.write('\nThere was no previous active database, so there is nothing to roll back to.\n');
    }
    return;
  }

  if(positionals.length!==1)throw new UsageError(`exactly one backup file is required. ${usage}`);
  if(values.db||values.port)throw new UsageError(`--db and --port are only used with --promote. ${usage}`);
  try{
    const {report,reportPath}=await verifyRestore({backup:positionals[0],manifest:values.manifest,target:values.target});
    process.stdout.write(JSON.stringify({ok:true,target:values.target,report:reportPath,sha256:report.sha256,userVersion:report.userVersion,tables:report.tables,checks:report.checks})+'\n');
  }catch(e){
    if(e.code&&e.code!=='TARGET_EXISTS'&&e.code!=='TARGET_PARENT_NOT_FOUND'&&!['BACKUP_NOT_FOUND','MANIFEST_NOT_FOUND','MANIFEST_INVALID','TARGET_REQUIRED'].includes(e.code)){
      e.message+=` (report: ${join(values.target,'verify-report.json')})`;
    }
    throw e;
  }
});
