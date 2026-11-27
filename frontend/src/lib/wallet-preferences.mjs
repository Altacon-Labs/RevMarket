const WALLET_OPT_IN_KEY = 'revmarket.freighter-opt-in';

export function hasWalletOptIn(storage = globalThis.localStorage) {
  try { return storage?.getItem(WALLET_OPT_IN_KEY) === 'true'; } catch { return false; }
}

export function setWalletOptIn(enabled, storage = globalThis.localStorage) {
  try {
    if (enabled) storage?.setItem(WALLET_OPT_IN_KEY, 'true');
    else storage?.removeItem(WALLET_OPT_IN_KEY);
  } catch {}
}
