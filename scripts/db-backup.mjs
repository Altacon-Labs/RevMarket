// Online backup of the backend SQLite database (safe while the API is running).
// Usage: node --experimental-sqlite scripts/db-backup.mjs --out <dir> [--db <path>]
import {parseArgs} from 'node:util';
import {createBackup} from '../backend/backup.mjs';
import {defaultDatabasePath,runCli,UsageError} from './db-cli.mjs';

await runCli('db:backup',async()=>{
  let values;
  try{({values}=parseArgs({strict:true,options:{out:{type:'string'},db:{type:'string'}}}));}
  catch(e){throw new UsageError(`${e.message}. Usage: db:backup --out <dir> [--db <path>]`);}
  if(!values.out)throw new UsageError('--out <dir> is required. Usage: db:backup --out <dir> [--db <path>]');
  const started=performance.now();
  const result=await createBackup({
    source:values.db??defaultDatabasePath(),
    outDir:values.out,
    onWarning:message=>process.stderr.write(`db:backup warning: ${message}\n`)
  });
  const {sha256,bytes,userVersion,createdAt,tables}=result.manifest;
  process.stdout.write(JSON.stringify({ok:true,backup:result.backupPath,manifest:result.manifestPath,sha256,bytes,userVersion,createdAt,tables,ms:Math.round(performance.now()-started)})+'\n');
});
