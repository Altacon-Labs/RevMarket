import {useEffect, useState} from 'react';
import {marketArtwork} from '../lib/market-artwork.mjs';

export default function MarketAvatar({market, size = 'regular'}) {
  const [failed, setFailed] = useState(false);
  const src = marketArtwork(market);

  useEffect(() => setFailed(false), [src]);

  if (failed) return <span className={`market-avatar market-avatar-${size} market-avatar-fallback`} aria-hidden="true">{market.kind === 'Price' ? market.asset : 'EV'}</span>;
  return <img className={`market-avatar market-avatar-${size}`} src={src} alt={`${market.kind === 'Price' ? market.asset : 'Event'} market artwork`} loading="lazy" decoding="async" onError={() => setFailed(true)} />;
}