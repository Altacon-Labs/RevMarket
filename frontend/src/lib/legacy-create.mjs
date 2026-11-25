import {priceUnits} from '../../../shared/amount.mjs';
import {resolveCollateralIdentity} from './backend.mjs';

// Mirrors the checks in contracts/market/src/lib.rs `create`.
export const LEGACY_CREATE_LIMITS = Object.freeze({
  questionBytes: 512,
  descriptionBytes: 128,
  imageCidBytes: 128,
  closeHorizonSeconds: 2_592_000,
  priceAssets: Object.freeze(['BTC', 'ETH', 'XLM']),
});

const EVENT_ARTWORK_REQUIRED = 'Event markets need artwork: the contract stores an image CID for every event market. Choose an image to upload.';
const utf8Bytes = value => new TextEncoder().encode(value).length;

export function encodeDescription(description) {
  return description ? `desc:${encodeURIComponent(description)}` : '';
}

export function prepareLegacyCreate({kind, category, question, asset, target, closes, description = '', hasArtwork}, {now}) {
  if (kind === 'event' && !hasArtwork) throw new Error(EVENT_ARTWORK_REQUIRED);

  const closesAt = Math.floor(new Date(closes).getTime() / 1000);
  if (!Number.isSafeInteger(closesAt) || closesAt <= now) throw new Error('Choose a future closing time');
  if (closesAt > now + LEGACY_CREATE_LIMITS.closeHorizonSeconds) throw new Error('Choose a closing time within 30 days; the contract rejects later dates.');

  const priceAsset = kind === 'price' ? asset : null;
  if (priceAsset && !LEGACY_CREATE_LIMITS.priceAssets.includes(priceAsset)) throw new Error('Price markets support BTC, ETH or XLM.');
  const threshold = priceAsset ? priceUnits(target) : 0n;
  const baseQuestion = priceAsset
    ? `Will ${priceAsset} be strictly above $${target} USD at the first post-close observation (within 90 seconds)?`
    : question;
  if (!baseQuestion) throw new Error('Enter a question');

  const tagged = category && category !== 'General';
  const finalQuestion = tagged ? `[${category}] ${baseQuestion}` : baseQuestion;
  const questionBytes = utf8Bytes(finalQuestion);
  if (questionBytes > LEGACY_CREATE_LIMITS.questionBytes) {
    throw new Error(`Question is ${questionBytes} bytes${tagged ? ` with the [${category}] tag` : ''}; the contract allows ${LEGACY_CREATE_LIMITS.questionBytes}. Shorten it by ${questionBytes - LEGACY_CREATE_LIMITS.questionBytes} bytes.`);
  }

  const descriptionCid = encodeDescription(description);
  const descriptionBytes = utf8Bytes(descriptionCid);
  if (descriptionBytes > LEGACY_CREATE_LIMITS.descriptionBytes) {
    throw new Error(`Description needs ${descriptionBytes} of ${LEGACY_CREATE_LIMITS.descriptionBytes} bytes once encoded for the contract (spaces and symbols take 3 bytes each). Shorten it.`);
  }

  return {kind, question: finalQuestion, descriptionCid, priceAsset, threshold, closesAt};
}

export function withLegacyArtwork(market, imageCid) {
  if (market.kind === 'event' && !imageCid) throw new Error(EVENT_ARTWORK_REQUIRED);
  const cidBytes = utf8Bytes(imageCid);
  if (cidBytes > LEGACY_CREATE_LIMITS.imageCidBytes) throw new Error(`Artwork CID is ${cidBytes} bytes; the contract allows ${LEGACY_CREATE_LIMITS.imageCidBytes}.`);
  return {...market, imageCid};
}

export function describeEscrow(tokenContractId) {
  const identity = resolveCollateralIdentity(tokenContractId, {fixtureMode: false, allowlist: []});
  return {
    contractId: tokenContractId,
    label: identity.available ? identity.displayLabel : `Unverified token ${tokenContractId}`,
  };
}

export function createdMarketId(result) {
  if (!Number.isSafeInteger(result.value)) throw new Error(`Transaction confirmed but no market id was returned; check transaction ${result.hash}.`);
  return result.value;
}
