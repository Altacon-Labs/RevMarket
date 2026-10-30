import { sc, normalizeMarket } from '../shared/stellar.mjs';
import { digest, resolvePrice, resolveEvent } from './policy.mjs';
export async function processMarket({client, source, sign, id, providers, saveEvidence, now = () => Math.floor(Date.now()/1000)}) {
  let m = normalizeMarket(await client.read(source, 'get_market', [sc.u32(id)]));
  const closesAt = Number(m.closes_at);
  if (m.status >= 2 || now() < closesAt || now() > Number(m.deadline)) return 'skipped';
  if (m.status === 0) await client.write(source, sign, 'request', [sc.u32(id)]);
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
  const evidence = {version:1, contractId:providers.contractId, marketId:id, question:m.question, closesAt, observations, decision};
  const hash = digest(evidence);
  await saveEvidence(hash, evidence); // Persist before submitting; digest commits to exact JSON bytes.
  m = normalizeMarket(await client.read(source, 'get_market', [sc.u32(id)]));
  if (m.status !== 1) return 'skipped';
  await client.write(source, sign, method, [sc.u32(id), ...args, sc.hash(Buffer.from(hash,'hex'))]);
  return 'settled';
}
