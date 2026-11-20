import { sc, normalizeMarket, Networks } from '../shared/stellar.mjs';
import { digest, resolvePrice, resolveEvent } from './policy.mjs';

export async function processMarket({client, source, sign, id, providers, saveEvidence, attemptStore, onMarketRead, network = Networks.TESTNET, now = () => Math.floor(Date.now()/1000)}) {
  let m = normalizeMarket(await client.read(source, 'get_market', [sc.u32(id)]));
  const closesAt = Number(m.closes_at);
  await onMarketRead?.({id, closesAt, deadline:Number(m.deadline), status:m.status, now:now()});
  if (m.status >= 2 || now() < closesAt || now() > Number(m.deadline)) return 'skipped';
  if (m.status === 0) await client.write(source, sign, 'request', [sc.u32(id)]);
  const contract = providers.contractId;
  const savedAttempt = attemptStore?.get(network, contract, id);
  if (savedAttempt && !['confirmed', 'failed', 'expired'].includes(savedAttempt.status)) {
    if (savedAttempt.status === 'prepared') {
      await client.submit(savedAttempt.signed_xdr);
      attemptStore.update(network, contract, id, 'submitted');
    }
    const current = await client.inspect(savedAttempt.hash);
    if (current.status === 'confirmed') { attemptStore.update(network, contract, id, 'confirmed'); return 'settled'; }
    if (current.status === 'failed') { attemptStore.update(network, contract, id, 'failed'); return 'failed'; }
    if (current.status === 'expired') { attemptStore.update(network, contract, id, 'expired'); }
    else return current.status === 'pending' ? 'pending' : 'unknown';
  }
  // Existing terminal attempts must remain available for inspection; do not overwrite their unique key.
  if (savedAttempt) return savedAttempt.status;
  // Rehearsal hook: callers may inject a fault after a prepared attempt is persisted to exercise restart/reconciliation.
  let observations, decision, method, args;
  if (m.kind === 'Price') {
    observations = await providers.price(m.asset);
    decision = resolvePrice(observations, closesAt, now()).toString();
    method = 'settle_price'; args = [sc.i128(decision)];
  } else {
    observations = await providers.event(id);
    decision = resolveEvent(observations, {id, question:m.question, closesAt, now:now()});
    method = 'settle_event'; args = [sc.u32(decision.outcome), sc.u32(decision.confidence)];
  }
  const evidence = {version:1, contractId:contract, marketId:id, question:m.question, closesAt, observations, decision};
  const hash = digest(evidence);
  await saveEvidence(hash, evidence);
  m = normalizeMarket(await client.read(source, 'get_market', [sc.u32(id)]));
  if (m.status !== 1) return 'skipped';
  if (!client.prepare || !client.submit || !attemptStore) {
    await client.write(source, sign, method, [sc.u32(id), ...args, sc.hash(Buffer.from(hash,'hex'))]);
    return 'settled';
  }
  const prepared = await client.prepare(source, sign, method, [sc.u32(id), ...args, sc.hash(Buffer.from(hash,'hex'))]);
  const attempt = attemptStore.begin({network, contract, market:id, hash:prepared.hash, signedXdr:prepared.xdr,
    evidenceHash:hash, sequence:prepared.sequence ?? ''});
  if (!attempt.created) return 'unknown';
  // A persisted prepared record is recoverable after a crash before this call.
  await client.submit(attempt.attempt.signed_xdr);
  attemptStore.update(network, contract, id, 'submitted');
  const state = await client.inspect(prepared.hash);
  if (state.status === 'confirmed') { attemptStore.update(network, contract, id, 'confirmed'); return 'settled'; }
  if (state.status === 'failed') { attemptStore.update(network, contract, id, 'failed'); return 'failed'; }
  if (state.status === 'expired') { attemptStore.update(network, contract, id, 'expired'); return 'expired'; }
  return state.status === 'pending' ? 'pending' : 'unknown';
}
