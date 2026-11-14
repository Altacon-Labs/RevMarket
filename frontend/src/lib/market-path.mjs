import {normalizeMarket, sc} from '../../../shared/stellar.mjs';

export const MAX_MARKET_ID = 999;

export function marketSlug(question) {
  return question.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'market';
}

export function marketPath(market, side = null) {
  const path = `/event/${marketSlug(market.question)}`;
  const selection = side === 0 || side === 1 ? `?side=${side}` : '';
  return `${path}${selection}#${market.id}`;
}

export function parseMarketSide(search = '') {
  const value = new URLSearchParams(typeof search === 'string' ? search : '').get('side');
  return value === '1' ? 1 : 0;
}

export function parseMarketId(hash = '', {maxId = MAX_MARKET_ID} = {}) {
  if (typeof hash !== 'string') {
    return {valid: false, id: null, reason: 'malformed'};
  }
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) {
    return {valid: false, id: null, reason: 'missing'};
  }
  if (!/^(0|[1-9]\d*)$/.test(raw)) {
    return {valid: false, id: null, reason: 'malformed'};
  }
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id < 0 || id > maxId) {
    return {valid: false, id: null, reason: 'out_of_range'};
  }
  return {valid: true, id, reason: null};
}

export function isMissingMarketError(error) {
  const message = String(error?.message || error || '');
  return /Error\(Contract,\s*#1\)|Missing|not found|unknown market/i.test(message);
}

export async function loadMarketDetail({
  hash,
  markets = [],
  positions = {},
  client = null,
  source = '',
  address = '',
  maxId = MAX_MARKET_ID,
  isCurrent = () => true,
}) {
  const parsed = typeof hash === 'number' ? parseMarketId(`#${hash}`, {maxId}) : parseMarketId(hash, {maxId});
  if (!parsed.valid) {
    return {
      status: 'missing',
      id: null,
      reason: parsed.reason,
      market: null,
      position: null,
      error: parsed.reason === 'missing' ? 'Market identifier is missing from the link.' : 'Market identifier is invalid or out of range.',
      committed: Boolean(isCurrent()),
    };
  }

  const id = parsed.id;
  const cachedMarket = Array.isArray(markets) ? markets.find(item => Number(item?.id) === id) || null : null;
  const hasCachedPosition = Boolean(address) && Object.prototype.hasOwnProperty.call(positions, id);

  if (cachedMarket) {
    if (!address) {
      return {status: 'ready', id, reason: null, market: cachedMarket, position: null, error: null, committed: Boolean(isCurrent())};
    }
    if (hasCachedPosition || !client || !source) {
      return {
        status: 'ready',
        id,
        reason: null,
        market: cachedMarket,
        position: hasCachedPosition ? positions[id] ?? null : null,
        error: null,
        committed: Boolean(isCurrent()),
      };
    }
    try {
      const position = await client.read(source, 'get_position', [sc.u32(id), sc.address(address)]);
      const committed = Boolean(isCurrent());
      return {status: 'ready', id, reason: null, market: cachedMarket, position: committed ? position ?? null : null, error: null, committed};
    } catch (error) {
      const committed = Boolean(isCurrent());
      return {
        status: 'error',
        id,
        reason: 'rpc_error',
        market: cachedMarket,
        position: null,
        error: error?.message || 'Unable to load wallet position from Stellar RPC.',
        committed,
      };
    }
  }

  if (!client || !source) {
    return {
      status: 'missing',
      id,
      reason: 'not_found',
      market: null,
      position: null,
      error: `Market #${id} is not in the loaded list.`,
      committed: Boolean(isCurrent()),
    };
  }

  try {
    const rawMarket = await client.read(source, 'get_market', [sc.u32(id)]);
    const market = {id, ...normalizeMarket(rawMarket)};
    let position = null;
    if (address) {
      position = (await client.read(source, 'get_position', [sc.u32(id), sc.address(address)])) ?? null;
    }
    const committed = Boolean(isCurrent());
    return {
      status: 'ready',
      id,
      reason: null,
      market: committed ? market : null,
      position: committed ? position : null,
      error: null,
      committed,
    };
  } catch (error) {
    const committed = Boolean(isCurrent());
    if (isMissingMarketError(error)) {
      return {
        status: 'missing',
        id,
        reason: 'not_found',
        market: null,
        position: null,
        error: `Market #${id} does not exist on the contract.`,
        committed,
      };
    }
    return {
      status: 'error',
      id,
      reason: 'rpc_error',
      market: null,
      position: null,
      error: error?.message || 'Unable to load market from Stellar RPC.',
      committed,
    };
  }
}
