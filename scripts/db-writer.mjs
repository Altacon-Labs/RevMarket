// Child-process helper for the backup tests and drill. Runs as a separate process so its connection
// really writes concurrently with the backup connection.
//   db-writer.mjs <db>               write transactions until "stop" arrives on stdin; prints "committed <n>"
//   db-writer.mjs <db> --hold        open the database, print "ready", hold the idle connection until "stop"
//   db-writer.mjs <db> --crash <n>   commit n transactions with auto-checkpoint off, then exit without closing
import {parseArgs} from 'node:util';
import {openStore} from '../backend/store.mjs';
import {insertDraft,syntheticWallet} from './db-fixture.mjs';

const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{hold:{type:'boolean'},crash:{type:'string'},'max-ms':{type:'string'}}});
const file=positionals[0];
if(!file){console.error('usage: db-writer.mjs <db> [--hold | --crash <n>] [--max-ms <ms>]');process.exit(2);}
const db=openStore(file);
let stopping=false;
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{if(chunk.includes('stop'))stopping=true;});
process.stdin.on('end',()=>{stopping=true;});
const deadline=Date.now()+Number(values['max-ms']??60000);

function writeOne(index){
  db.exec('BEGIN IMMEDIATE');
  try{
    insertDraft(db,{index,owner:syntheticWallet(index%7),reviewer:syntheticWallet(1_000_000),time:1_900_000_000+index});
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}

if(values.crash!==undefined){
  db.exec('PRAGMA wal_autocheckpoint=0');
  const n=Number(values.crash);
  for(let i=0;i<n;i++)writeOne(i);
  process.stdout.write(`committed ${n}\n`,()=>process.exit(0));
}else if(values.hold){
  db.prepare('SELECT count(*) FROM drafts').get();
  process.stdout.write('ready\n');
  const timer=setInterval(()=>{if(stopping||Date.now()>deadline){clearInterval(timer);db.close();process.stdout.write('done\n');process.stdin.destroy();}},20);
}else{
  let committed=0;
  while(!stopping&&Date.now()<deadline){
    writeOne(committed);
    committed++;
    process.stdout.write(`committed ${committed}\n`);
    await new Promise(resolve=>setImmediate(resolve));
  }
  db.close();
  process.stdout.write(`done ${committed}\n`);
  process.stdin.destroy();
}
