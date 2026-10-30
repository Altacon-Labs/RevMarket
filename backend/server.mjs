import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {openStore} from './store.mjs';
import {createApi} from './app.mjs';
const filename=process.env.BACKEND_DB?resolve(process.env.BACKEND_DB):fileURLToPath(new URL('./data/revmarket.sqlite',import.meta.url));
const port=Number(process.env.BACKEND_PORT||3001);
const superAdminWallets=(process.env.SUPER_ADMIN_WALLETS||'').split(',').map(wallet=>wallet.trim()).filter(Boolean);
const pinataJwt=process.env.PINATA_JWT||'';
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid BACKEND_PORT');
await mkdir(dirname(filename),{recursive:true});
const db=openStore(filename);
const server=createApi({db,appOrigin:process.env.APP_ORIGIN||'http://127.0.0.1:5173',superAdminWallets,pinataJwt});
server.on('error',()=>{console.error('Backend could not listen; check local port and configuration');db.close();process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`RevMarket backend: http://127.0.0.1:${port}/api/health`));
let stopping=false;
function stop(){if(stopping)return;stopping=true;server.close(()=>{db.close();});server.closeIdleConnections();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
