const productIds = {BTC: 'BTC-USD', ETH: 'ETH-USD', XLM: 'XLM-USD'};

export async function fetchPriceCandles(asset, {signal, granularity = 3600} = {}) {
  const productId = productIds[asset];
  if (!productId) throw new Error(`No live price chart is available for ${asset}.`);

  const endpoint = new URL(`https://api.exchange.coinbase.com/products/${productId}/candles`);
  endpoint.searchParams.set('granularity', String(granularity));
  const response = await fetch(endpoint, {signal, cache: 'no-store', headers: {Accept: 'application/json'}});
  if (!response.ok) throw new Error(`Coinbase candle request failed (${response.status}).`);

  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Coinbase returned invalid candle data.');

  const candles = rows.flatMap(row => {
    if (!Array.isArray(row) || row.length < 6) return [];
    const [time, low, high, open, close, volume] = row.map(Number);
    if (![time, low, high, open, close, volume].every(Number.isFinite) || time <= 0 || low <= 0 || high <= 0 || open <= 0 || close <= 0) return [];
    return [{time: time * 1000, low, high, open, close, volume}];
  }).sort((first, second) => first.time - second.time);

  if (candles.length < 2) throw new Error('Coinbase returned too little candle data to chart.');
  return {asset, productId, source: 'Coinbase', granularity, candles};
}