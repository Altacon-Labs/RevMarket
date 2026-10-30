import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '../shared/stellar.mjs';
import { processMarket } from './runner.mjs';
import { priceObservations, eventObservations } from './providers.mjs';
const env = process.env;
if (!env.RESOLVER_SECRET || !env.CONTRACT_ID) throw new Error('Set RESOLVER_SECRET and CONTRACT_ID in server environment');
const key = Keypair.fromSecret(env.RESOLVER_SECRET);
const source = key.publicKey();
const client = createClient({rpcUrl:env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',contractId:env.CONTRACT_ID});
const sign = async (xdr, network) => { const tx=TransactionBuilder.fromXDR(xdr,network); tx.sign(key); return tx.toXDR(); };
const providers = {contractId:env.CONTRACT_ID, price:priceObservations, event:id=>eventObservations(JSON.parse(env.EVENT_SOURCE_URLS || '[]'),id)};
const directory = new URL('./evidence/', import.meta.url);
await mkdir(directory, {recursive:true});
const saveEvidence = async (hash, body) => {
  try { await writeFile(new URL(`${hash}.json`,directory), JSON.stringify(body), {flag:'wx',mode:0o600}); }
  catch(e) { if(e.code !== 'EEXIST') throw e; }
};
// One worker instance per resolver account. Never log credentials or upstream bodies.
do {
  try {
    const count = await client.read(source,'count');
    if (count > 1000) throw new Error('Scan limit exceeded; deploy an indexer before scaling');
    for (let id=0; id<count; id++) {
      try { const result=await processMarket({client,source,sign,id,providers,saveEvidence}); if(result==='settled') console.log(`Market ${id} settled`); }
      catch { console.error(`Market ${id}: resolution deferred; inspect providers and on-chain status`); }
    }
  } catch { console.error('Resolver scan failed; check configuration and RPC'); }
  if (env.RUN_ONCE === '1') break;
  await new Promise(r=>setTimeout(r,10_000));
} while(true);
