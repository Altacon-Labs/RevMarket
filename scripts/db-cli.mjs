// Shared helpers for the db:* command-line wrappers.
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Same resolution as backend/server.mjs.
export function defaultDatabasePath(env=process.env){
  return env.BACKEND_DB?resolve(env.BACKEND_DB):fileURLToPath(new URL('../backend/data/revmarket.sqlite',import.meta.url));
}

export function defaultPort(env=process.env){
  return Number(env.BACKEND_PORT||3001);
}

// Expected errors print one line with a stable code; nothing else (no stack, no row data).
export async function runCli(name,main){
  try{await main();}
  catch(e){
    const code=e?.code&&/^[A-Z_]+$/.test(e.code)?e.code:'UNEXPECTED';
    process.stderr.write(`${name} failed [${code}]: ${e?.message??e}\n`);
    process.exitCode=1;
  }
}

export class UsageError extends Error{constructor(message){super(message);this.code='USAGE';}}
