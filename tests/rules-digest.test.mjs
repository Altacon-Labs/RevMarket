import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  RULES_SCHEMA,
  canonicalizeJson,
  normalizeRulesV1,
  encodeRulesV1,
  hashRulesV1,
  rulesDigest,
} from '../shared/rules-digest.mjs';

const RESOLVER_G = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';
const COLLATERAL_C = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

function baseRules(overrides = {}) {
  return {
    schema: RULES_SCHEMA,
    network: 'testnet',
    question: 'Will BTC/USD exceed 100,000 USD at the observation time?',
    category: 'crypto',
    tradingClose: 1800000000,
    observationTime: 1800000060,
    resolutionDeadline: 1800086400,
    yesRule: 'Spot median across listed sources is strictly greater than 100000.00 USD.',
    noRule: 'Spot median across listed sources is less than or equal to 100000.00 USD.',
    equalityRule: 'Exact equality at 100000.00 USD resolves to NO.',
    sources: [
      'https://api.coinbase.com/v2/prices/BTC-USD/spot',
      'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
      'https://www.bitstamp.net/api/v2/ticker/btcusd/',
    ],
    fallbackRule: 'If one source is unavailable, resolve when two remaining sources agree within 2 percent.',
    unavailableDataRule: 'If fewer than two sources report within the window, market resolves Invalid.',
    collateral: 'native',
    feeBps: 30,
    resolver: RESOLVER_G,
    policyVersion: 'v1.0.0',
    implementationVersion: 'v2.0.0-rc1',
    ...overrides,
  };
}

test('equivalent input field ordering produces identical RFC 8785 bytes and SHA-256 digest', () => {
  const ordered = baseRules();
  const reversed = Object.fromEntries(Object.entries(baseRules()).reverse());

  const encA = encodeRulesV1(ordered);
  const encB = encodeRulesV1(reversed);

  assert.equal(encA.json, encB.json);
  assert.deepEqual(encA.bytes, encB.bytes);
  assert.equal(encA.digest, encB.digest);
  assert.equal(hashRulesV1(ordered), rulesDigest(reversed));
  assert.match(encA.digest, /^[0-9a-f]{64}$/);

  const expectedJson =
    '{"category":"crypto","collateral":"native","equalityRule":"Exact equality at 100000.00 USD resolves to NO.","fallbackRule":"If one source is unavailable, resolve when two remaining sources agree within 2 percent.","feeBps":30,"implementationVersion":"v2.0.0-rc1","network":"testnet","noRule":"Spot median across listed sources is less than or equal to 100000.00 USD.","observationTime":1800000060,"policyVersion":"v1.0.0","question":"Will BTC/USD exceed 100,000 USD at the observation time?","resolutionDeadline":1800086400,"resolver":"GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H","schema":"revmarket.rules.v1","sources":["https://api.coinbase.com/v2/prices/BTC-USD/spot","https://api.kraken.com/0/public/Ticker?pair=XBTUSD","https://www.bitstamp.net/api/v2/ticker/btcusd/"],"tradingClose":1800000000,"unavailableDataRule":"If fewer than two sources report within the window, market resolves Invalid.","yesRule":"Spot median across listed sources is strictly greater than 100000.00 USD."}';

  assert.equal(encA.json, expectedJson);
  assert.equal(encA.digest, createHash('sha256').update(Buffer.from(expectedJson, 'utf8')).digest('hex'));
});

test('explicit null for inapplicable observationTime, equalityRule and fallbackRule is preserved', () => {
  const eventRules = baseRules({
    observationTime: null,
    equalityRule: null,
    fallbackRule: null,
    collateral: COLLATERAL_C,
  });
  const encoded = encodeRulesV1(eventRules);
  assert.ok(encoded.json.includes('"observationTime":null'));
  assert.ok(encoded.json.includes('"equalityRule":null'));
  assert.ok(encoded.json.includes('"fallbackRule":null'));
  assert.ok(encoded.json.includes(`"collateral":"${COLLATERAL_C}"`));
});

test('nested source objects canonicalize property order while preserving array order', () => {
  const r1 = baseRules({
    sources: [
      {url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', id: 'coinbase', weight: 1},
      {weight: 1, id: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD'},
    ],
  });
  const r2 = baseRules({
    sources: [
      {weight: 1, url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', id: 'coinbase'},
      {id: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', weight: 1},
    ],
  });
  const swappedOrder = baseRules({
    sources: [
      {id: 'kraken', url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD', weight: 1},
      {id: 'coinbase', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', weight: 1},
    ],
  });

  assert.equal(encodeRulesV1(r1).json, encodeRulesV1(r2).json);
  assert.equal(hashRulesV1(r1), hashRulesV1(r2));
  assert.notEqual(hashRulesV1(r1), hashRulesV1(swappedOrder));
});

test('material changes to rules, sources, deadlines, collateral or resolver change the digest', () => {
  const baseHash = hashRulesV1(baseRules());
  const mutations = [
    {network: 'public'},
    {question: 'Will BTC/USD exceed 105,000 USD at the observation time?'},
    {category: 'macro'},
    {tradingClose: 1800000001},
    {observationTime: 1800000120},
    {observationTime: null},
    {resolutionDeadline: 1800086401},
    {yesRule: 'Spot median is at least 100000.00 USD.'},
    {noRule: 'Spot median is strictly below 100000.00 USD.'},
    {equalityRule: null},
    {sources: ['https://api.coinbase.com/v2/prices/BTC-USD/spot']},
    {
      sources: [
        'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
        'https://api.coinbase.com/v2/prices/BTC-USD/spot',
        'https://www.bitstamp.net/api/v2/ticker/btcusd/',
      ],
    },
    {fallbackRule: null},
    {unavailableDataRule: 'Resolve NO if data is unavailable.'},
    {collateral: COLLATERAL_C},
    {feeBps: 50},
    {resolver: COLLATERAL_C},
    {policyVersion: 'v1.0.1'},
    {implementationVersion: 'v2.0.1'},
  ];

  for (const patch of mutations) {
    const mutatedHash = hashRulesV1(baseRules(patch));
    assert.notEqual(mutatedHash, baseHash, `Mutation ${JSON.stringify(patch)} must change digest`);
  }
});

test('display metadata, local IDs, review notes and signatures are excluded from digest', () => {
  const clean = baseRules();
  const withEnvelope = {
    ...baseRules(),
    id: 42,
    draftId: 42,
    revisionId: 99,
    revisionNumber: 3,
    metadata: {bannerCid: 'bafybeihgxdzljxb26q6nf3r3eifqeedsvt2eubqtskghpme66cgjyw4fra', featured: true},
    reviewNotes: 'Approved after checking source endpoints',
    reason: 'LGTM',
    signature: 'deadbeef',
    origin: 'ai_assisted',
    status: 'approved',
    contentHash: 'legacy-revision-hash',
  };

  const encClean = encodeRulesV1(clean);
  const encEnvelope = encodeRulesV1(withEnvelope);
  assert.equal(encEnvelope.json, encClean.json);
  assert.equal(encEnvelope.digest, encClean.digest);
  assert.equal('metadata' in encEnvelope.payload, false);
  assert.equal('id' in encEnvelope.payload, false);
  assert.equal('signature' in encEnvelope.payload, false);
});

test('Unicode text and RFC 8785 control character escaping are deterministic', () => {
  const unicodeRules = baseRules({
    question: 'Will Eurozone CPI (YoY \u20ac / \u00e9valuation) exceed 2.5%?\nLine two\tTabbed',
  });
  const encoded = encodeRulesV1(unicodeRules);
  assert.ok(encoded.json.includes('YoY \u20ac / \u00e9valuation'));
  assert.ok(encoded.json.includes('\\nLine two\\tTabbed'));
  assert.equal(encoded.digest.length, 64);

  // Control character 0x01 uses lowercase 4-hex-digit escape per RFC 8785.
  assert.equal(canonicalizeJson({a: '\u0001'}), '{"a":"\\u0001"}');
});

test('invalid schema, unsafe numbers, malformed Unicode and bad addresses are rejected', () => {
  assert.throws(() => encodeRulesV1(null), /plain object/);
  assert.throws(() => encodeRulesV1(baseRules({schema: 'revmarket.rules.v0'})), /schema/);
  assert.throws(() => encodeRulesV1(baseRules({unexpectedField: 'nope'})), /Unexpected field/);
  assert.throws(() => encodeRulesV1(baseRules({tradingClose: 1800000000.5})), /safe integer/);
  assert.throws(() => encodeRulesV1(baseRules({tradingClose: Number.MAX_SAFE_INTEGER + 1})), /safe integer/);
  assert.throws(() => encodeRulesV1(baseRules({tradingClose: -0})), /safe integer/);
  assert.throws(() => encodeRulesV1(baseRules({observationTime: 1799999999})), /observationTime/);
  assert.throws(() => encodeRulesV1(baseRules({resolutionDeadline: 1800000000})), /resolutionDeadline/);
  assert.throws(() => encodeRulesV1(baseRules({resolutionDeadline: 1800000030})), /resolutionDeadline/);
  assert.throws(() => encodeRulesV1(baseRules({equalityRule: undefined})), /explicitly null/);
  assert.throws(() => encodeRulesV1(baseRules({equalityRule: '   '})), /non-empty/);
  assert.throws(() => encodeRulesV1(baseRules({fallbackRule: ''})), /non-empty/);
  assert.throws(() => encodeRulesV1(baseRules({sources: []})), /sources/);
  assert.throws(() => encodeRulesV1(baseRules({sources: ['http://insecure.example/feed']})), /https:\/\//);
  assert.throws(() => encodeRulesV1(baseRules({sources: ['https://user:pass@example.com/feed']})), /credentials/);
  assert.throws(() => encodeRulesV1(baseRules({collateral: 'USDC'})), /collateral/);
  assert.throws(() => encodeRulesV1(baseRules({feeBps: -1})), /feeBps/);
  assert.throws(() => encodeRulesV1(baseRules({feeBps: 1001})), /feeBps/);
  assert.throws(() => encodeRulesV1(baseRules({resolver: 'G_INVALID_KEY'})), /resolver/);

  // Lone UTF-16 surrogates must be rejected.
  assert.throws(() => encodeRulesV1(baseRules({question: 'Bad surrogate \uD800 here'})), /Unicode/);
  assert.throws(() => canonicalizeJson('Lone low surrogate \uDC00'), /surrogate/);
});
