/**
 * Fallback mock markets for preview and initial platform demonstration.
 * When on-chain contracts or backend markets are populated, live data seamlessly takes precedence.
 */
export const MOCK_MARKETS = [
  {
    id: 991,
    creator: 'GCLAC7YXZA7Z6H3ZKJ7X6P7E5K3J7W6M5L9Q8A4R1S2T3U4V5W6X7Y8Z',
    question: 'Will XLM spot price be strictly above $0.35 USD at weekly settlement?',
    description_cid: '',
    image_cid: '',
    kind: 'Price',
    asset: 'XLM',
    threshold: 35000000n,
    closes_at: BigInt(Math.floor(Date.now() / 1000) + 86400 * 3),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86400 * 4),
    status: 0,
    yes_pool: 28450000000n, // 2845.0 XLM
    no_pool: 14200000000n,  // 1420.0 XLM
    outcome: 0,
    confidence: 10000,
    evidence: new Uint8Array(32),
    latest_activity: {
      action: 'BUY YES',
      amount: '250 XLM',
      timeAgo: '2m ago',
      user: 'GC...4R1S'
    }
  },
  {
    id: 992,
    creator: 'GBBM627TYK4Z9M2P1Q8R3S4T5U6V7W8X9Y0Z1A2B3C4D5E6F7G8H9I0J',
    question: 'Will Soroban Protocol 23 upgrade complete without unhandled consensus halt?',
    description_cid: '',
    image_cid: '',
    kind: 'Event',
    asset: null,
    threshold: 0n,
    closes_at: BigInt(Math.floor(Date.now() / 1000) + 86400 * 5),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86400 * 6),
    status: 0,
    yes_pool: 64200000000n, // 6420.0 XLM
    no_pool: 9800000000n,   // 980.0 XLM
    outcome: 0,
    confidence: 9500,
    evidence: new Uint8Array(32),
    latest_activity: {
      action: 'BUY YES',
      amount: '1,200 XLM',
      timeAgo: '4m ago',
      user: 'GB...5E6F'
    }
  },
  {
    id: 993,
    creator: 'GCX7R8S9T0U1V2W3X4Y5Z6A7B8C9D0E1F2G3H4I5J6K7L8M9N0O1P2Q3',
    question: 'Will BTC trade strictly above $95,000 USD on Coinbase before month-end?',
    description_cid: '',
    image_cid: '',
    kind: 'Price',
    asset: 'BTC',
    threshold: 9500000000000n,
    closes_at: BigInt(Math.floor(Date.now() / 1000) + 86400 * 8),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86400 * 9),
    status: 0,
    yes_pool: 125000000000n, // 12,500.0 XLM
    no_pool: 89000000000n,   // 8,900.0 XLM
    outcome: 0,
    confidence: 10000,
    evidence: new Uint8Array(32),
    latest_activity: {
      action: 'BUY NO',
      amount: '500 XLM',
      timeAgo: '7m ago',
      user: 'GC...L8M9'
    }
  },
  {
    id: 994,
    creator: 'GA7Z1Y2X3W4V5U6T7S8R9Q0P1O2N3M4L5K6J7I8H9G0F1E2D3C4B5A6Z',
    question: 'Will ETH 30-day realized volatility drop below 40% before expiration?',
    description_cid: '',
    image_cid: '',
    kind: 'Price',
    asset: 'ETH',
    threshold: 280000000000n,
    closes_at: BigInt(Math.floor(Date.now() / 1000) + 86400 * 2),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86400 * 3),
    status: 0,
    yes_pool: 41200000000n,
    no_pool: 38900000000n,
    outcome: 0,
    confidence: 10000,
    evidence: new Uint8Array(32),
    latest_activity: {
      action: 'BUY YES',
      amount: '350 XLM',
      timeAgo: '11m ago',
      user: 'GA...E2D3'
    }
  },
  {
    id: 995,
    creator: 'GD8V9W0X1Y2Z3A4B5C6D7E8F9G0H1I2J3K4L5M6N7O8P9Q0R1S2T3U4V',
    question: 'Will Stellar Community Fund (SCF) Wave 25 award announce on or before schedule?',
    description_cid: '',
    image_cid: '',
    kind: 'Event',
    asset: null,
    threshold: 0n,
    closes_at: BigInt(Math.floor(Date.now() / 1000) - 3600), // Closed, pending settlement
    deadline: BigInt(Math.floor(Date.now() / 1000) + 86400),
    status: 1, // Resolution requested
    yes_pool: 52100000000n,
    no_pool: 11400000000n,
    outcome: 0,
    confidence: 9200,
    evidence: new Uint8Array(32),
  },
  {
    id: 996,
    creator: 'GB9U8T7S6R5Q4P3O2N1M0L9K8J7I6H5G4F3E2D1C0B9A8Z7Y6X5W4V3U',
    question: 'Did US CPI Inflation print strictly below 2.9% year-over-year in latest release?',
    description_cid: '',
    image_cid: '',
    kind: 'Event',
    asset: null,
    threshold: 0n,
    closes_at: BigInt(Math.floor(Date.now() / 1000) - 86400 * 2),
    deadline: BigInt(Math.floor(Date.now() / 1000) - 86400),
    status: 2, // Settled
    yes_pool: 31000000000n,
    no_pool: 49000000000n,
    outcome: 1, // NO won
    confidence: 9900,
    evidence: new Uint8Array(32),
  }
];

