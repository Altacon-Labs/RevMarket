const tokenArtwork = {
  BTC: 'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/btc.png',
  ETH: 'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/eth.png',
  XLM: 'https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/128/color/xlm.png',
};

export const fallbackMarketArtwork = 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=640&q=80';
const cidPattern = /^(?:bafy[a-z2-7]{20,}|Qm[1-9A-HJ-NP-Za-km-z]{44})$/;
const defaultGateway = 'https://gateway.pinata.cloud/ipfs';

export function marketArtwork(market) {
  if (typeof market.image_cid === 'string' && cidPattern.test(market.image_cid)) {
    const configuredGateway = import.meta.env?.VITE_IPFS_GATEWAY || defaultGateway;
    try {
      const gateway = new URL(configuredGateway);
      if (gateway.protocol === 'https:') return `${gateway.href.replace(/\/$/, '')}/${market.image_cid}`;
    } catch {}
  }
  if (market.kind === 'Price' && tokenArtwork[market.asset]) return tokenArtwork[market.asset];
  return fallbackMarketArtwork;
}