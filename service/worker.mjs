import { Keypair, TransactionBuilder } from '@stellar/stellar-sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '../shared/stellar.mjs';
import { processMarket } from './runner.mjs';
import { createAttemptStore } from './attempts.mjs';
import { pollDueMarkets } from './scheduler.mjs';
import { priceObservations, eventObservations } from './providers.mjs';
import {writeStructuredLog} from '../shared/observability.mjs';

const env = process.env;
if (!env.RESOLVER_SECRET || !env.CONTRACT_ID) throw new Error('Set RESOLVER_SECRET and CONTRACT_ID in server environment');

const key = Keypair.fromSecret(env.RESOLVER_SECRET);
const source = key.publicKey();
const client = createClient({rpcUrl:env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',contractId:env.CONTRACT_ID});
const attemptStore = createAttemptStore(env.ATTEMPTS_DB_PATH || new URL('./attempts.sqlite', import.meta.url).pathname);
const sign = async (xdr, network) => { const tx=TransactionBuilder.fromXDR(xdr,network); tx.sign(key); return tx.toXDR(); };
const providers = {contractId:env.CONTRACT_ID, price:priceObservations, event:id=>eventObservations(JSON.parse(env.EVENT_SOURCE_URLS || '[]'),id)};
const directory = new URL(env.EVIDENCE_DIR ? `file://${env.EVIDENCE_DIR.replace(/\/$/,'')}/` : './evidence/', import.meta.url);
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
    await pollDueMarkets({store:attemptStore,network:'testnet',contract:env.CONTRACT_ID,count,batchSize:Number(env.SETTLEMENT_BATCH_SIZE || 25),
      process:(id,onMarketRead)=>processMarket({client,source,sign,id,providers,saveEvidence,attemptStore,onMarketRead}),
      onAttempt:event=>writeStructuredLog(event.event==='worker_attempt_deferred'?'error':'info',{...event,service:'revmarket-worker'}),
      onError:()=>{}});
  } catch { writeStructuredLog('error',{service:'revmarket-worker',event:'worker_scan',reasonCode:'worker_scan_failed'}); }
  if (env.RUN_ONCE === '1') break;
  await new Promise(r=>setTimeout(r,10_000));
} while(true);
