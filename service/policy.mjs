import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function resolvePrice(observations, closesAt, now) {
  if (now < closesAt || now > closesAt + 90) throw new Error('Price observation window missed');
  if (observations.length !== 3 || new Set(observations.map(x => x.source)).size !== 3) throw new Error('Three independent sources required');
  for (const x of observations) {
    if (typeof x.price !== 'string' || !/^[1-9]\d*$/.test(x.price) || BigInt(x.price) > 10n**24n || !Number.isInteger(x.observedAt) || x.observedAt < closesAt || x.observedAt > now + 5 || now - x.observedAt > 60) throw new Error('Invalid or stale price');
  }
  const prices = observations.map(x => BigInt(x.price)).sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
  if ((prices[2] - prices[0]) * 10_000n > prices[1] * 200n) throw new Error('Price spread exceeds 2%');
  return prices[1];
}
export function resolveEvent(observations, {id, question, closesAt, now}) {
  if (now < closesAt) throw new Error('Market still open');
  if (observations.length < 2 || new Set(observations.map(x => x.source)).size !== observations.length) throw new Error('Distinct evidence sources required');
  const hash = digest(question);
  for (const x of observations) {
    if (x.marketId !== id || x.questionHash !== hash || ![0,1].includes(x.outcome) || !Number.isInteger(x.confidence) || x.confidence < 8000 || x.confidence > 10000 || !Number.isInteger(x.observedAt) || x.observedAt < closesAt || x.observedAt > now + 5 || now - x.observedAt > 3600 || !/^https:\/\//.test(x.evidenceUrl)) throw new Error('Invalid event evidence');
  }
  if (!observations.every(x => x.outcome === observations[0].outcome)) throw new Error('Conflicting evidence; abstaining');
  return {outcome: observations[0].outcome, confidence: Math.min(...observations.map(x => x.confidence))};
}
