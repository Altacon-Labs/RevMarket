export const SCALE = 10_000_000n;
export function parseAmount(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,7})?$/.test(value)) throw new Error('Use a positive amount with at most 7 decimals');
  const [whole, fraction = ''] = value.split('.');
  const amount = BigInt(whole) * SCALE + BigInt(fraction.padEnd(7, '0'));
  if (amount <= 0n || amount > 1_000_000_000_000_000_000n) throw new Error('Amount outside supported range');
  return amount;
}
export function formatAmount(value) {
  const n = BigInt(value);
  return `${n / SCALE}.${(n % SCALE).toString().padStart(7, '0')}`;
}
export function priceUnits(value) {
  if (!/^(0|[1-9]\d*)(\.\d{1,8})?$/.test(value)) throw new Error('Invalid USD price (maximum 8 decimals)');
  const [w, f = ''] = value.split('.');
  const n = BigInt(w) * 100_000_000n + BigInt(f.padEnd(8, '0'));
  if (n <= 0n || n > 10n ** 24n) throw new Error('Price outside supported range');
  return n;
}
