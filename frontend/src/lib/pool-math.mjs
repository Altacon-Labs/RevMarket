const SCALE = 10_000_000n;

export function parseStakeUnits(value) {
  const input = String(value ?? '').trim();
  if (!input || !/^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(input)) return 0n;
  const [whole, fraction = ''] = input.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(7, '0'));
}

// Mirrors claim_inner in contracts/market/src/lib.rs after predict adds the stake.
export function estimateLegacyPayout({yesPool, noPool, side, stake}) {
  const amount = BigInt(stake);
  if (amount <= 0n || (side !== 0 && side !== 1)) return null;
  const yes = BigInt(yesPool);
  const no = BigInt(noPool);
  const winningPoolAfterStake = (side === 0 ? yes : no) + amount;
  const totalPoolAfterStake = yes + no + amount;
  if (winningPoolAfterStake <= 0n) return null;
  return amount * totalPoolAfterStake / winningPoolAfterStake;
}

export function poolShares(yesPool, noPool) {
  const yes = BigInt(yesPool);
  const no = BigInt(noPool);
  const total = yes + no;
  if (total === 0n) return null;
  const yesPercent = Number(yes * 10_000n / total) / 100;
  return {yes: yesPercent, no: 100 - yesPercent};
}
