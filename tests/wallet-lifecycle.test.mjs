import test from 'node:test';
import assert from 'node:assert/strict';
import {hasWalletOptIn, setWalletOptIn} from '../frontend/src/lib/wallet-preferences.mjs';

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

test('wallet restoration is opt-in and can be explicitly enabled or disabled', () => {
  const storage = createStorage();
  assert.equal(hasWalletOptIn(storage), false);
  setWalletOptIn(true, storage);
  assert.equal(hasWalletOptIn(storage), true);
  setWalletOptIn(false, storage);
  assert.equal(hasWalletOptIn(storage), false);
});

test('wallet preference storage failures fail closed', () => {
  const unavailable = {
    getItem() { throw new Error('storage blocked'); },
    setItem() { throw new Error('storage blocked'); },
    removeItem() { throw new Error('storage blocked'); },
  };
  assert.equal(hasWalletOptIn(unavailable), false);
  assert.doesNotThrow(() => setWalletOptIn(true, unavailable));
});
