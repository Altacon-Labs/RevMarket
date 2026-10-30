import test from 'node:test';
import assert from 'node:assert/strict';
import {fallbackMarketArtwork, marketArtwork} from '../frontend/src/lib/market-artwork.mjs';

const cid='bafybeihgxdzljxb26q6nf3r3eifqeedsvt2eubqtskghpme66cgjyw4fra';

test('creator image CID resolves through HTTPS and takes precedence over token artwork',()=>{
  assert.equal(marketArtwork({kind:'Price',asset:'BTC',image_cid:cid}),`https://gateway.pinata.cloud/ipfs/${cid}`);
});

test('price markets fall back to their token mark and malformed event CIDs use generic artwork',()=>{
  assert.match(marketArtwork({kind:'Price',asset:'BTC'}),/\/btc\.png$/);
  assert.equal(marketArtwork({kind:'Event',image_cid:'https://example.com/image.jpg'}),fallbackMarketArtwork);
});