import { priceUnits } from '../shared/amount.mjs';
export async function getJson(url, fetcher = fetch) {
  const r = await fetcher(url, {signal: AbortSignal.timeout(8000), redirect:'error', headers:{Accept:'application/json'}});
  if (!r.ok) throw new Error(`Evidence provider HTTP ${r.status}`);
  const text = await r.text();
  if (text.length > 100_000) throw new Error('Evidence response too large');
  return JSON.parse(text);
}
// Sampling policy: USD spot observed immediately after close, not a historical closing price.
// Receipt timestamps are operator observations, not provider attestations.
export async function priceObservations(asset, fetcher = fetch, clock = () => Math.floor(Date.now()/1000)) {
  if (!['BTC','ETH','XLM'].includes(asset)) throw new Error('Unsupported asset');
  const kraken = {BTC:'XXBTZUSD',ETH:'XETHZUSD',XLM:'XXLMZUSD'}[asset];
  return Promise.all([
    ['coinbase', `https://api.coinbase.com/v2/prices/${asset}-USD/spot`, x=>x.data.amount],
    ['kraken', `https://api.kraken.com/0/public/Ticker?pair=${kraken}`, x=>Object.values(x.result)[0].c[0]],
    ['bitstamp', `https://www.bitstamp.net/api/v2/ticker/${asset.toLowerCase()}usd/`, x=>x.last],
  ].map(async ([source,url,extract]) => {
    const body = await getJson(url, fetcher);
    return {source, url, price:priceUnits(String(extract(body))).toString(), observedAt:clock()};
  }));
}
export async function eventObservations(endpoints, id, fetcher = fetch) {
  if (endpoints.length < 2 || endpoints.length > 5) throw new Error('Configure 2–5 event evidence providers');
  const urls = endpoints.map(s => new URL(s));
  if (urls.some(u=>u.protocol !== 'https:' || u.username || u.password) || new Set(urls.map(u=>u.hostname)).size !== urls.length) throw new Error('Distinct HTTPS evidence hosts required');
  return Promise.all(urls.map(async url=> {
    url.searchParams.set('marketId', String(id));
    return {...await getJson(url, fetcher), source:url.hostname};
  }));
}
