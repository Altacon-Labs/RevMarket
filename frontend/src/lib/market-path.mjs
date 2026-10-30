export function marketSlug(question) {
  return question.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'market';
}

export function marketPath(market, side = null) {
  const path = `/event/${marketSlug(market.question)}`;
  const selection = side === 0 || side === 1 ? `?side=${side}` : '';
  return `${path}${selection}#${market.id}`;
}