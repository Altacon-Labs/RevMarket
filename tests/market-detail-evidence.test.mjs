import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {fileURLToPath} from 'node:url';

const FIXTURE_DIGEST = '7a52df7e56ccf05cef40ec4f8e2958f779b24824855a82091731e7d7a4360051';
const FIXTURE_CONTRACT = 'CCRZ7JKPNKRLPJO5XWF5WBBDOIU3UXCNP3PDEQ3YHYV4CVDC6WTHZ323';
const frontendRoot = fileURLToPath(new URL('../frontend', import.meta.url));

function settledMarket() {
  return {
    id: 996,
    question: 'Integration fixture: deterministic YES (not a real-world event)',
    kind: 'Event',
    asset: null,
    threshold: 0n,
    closes_at: 1793201196n,
    deadline: 1793204796n,
    status: 2,
    yes_pool: 31_000_000_000n,
    no_pool: 49_000_000_000n,
    outcome: 1,
    confidence: 9900,
    evidence: Uint8Array.from(Buffer.from(FIXTURE_DIGEST, 'hex')),
  };
}

test('the reachable market detail route renders the settlement outcome and local evidence verifier', async t => {
  const server = await createServer({
    root: frontendRoot,
    logLevel: 'silent',
    appType: 'custom',
    server: {middlewareMode: true},
  });
  t.after(() => server.close());

  const {default: MarketDetailPage} = await server.ssrLoadModule('/src/components/MarketDetailPage.jsx');
  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      {initialEntries: [{pathname: '/event/deterministic-yes', hash: '#996', search: ''}]},
      React.createElement(MarketDetailPage, {
        markets: [settledMarket()],
        positions: {},
        now: 1793204800,
        contractId: FIXTURE_CONTRACT,
      }),
    ),
  );

  assert.match(html, /SETTLEMENT EVIDENCE/);
  assert.match(html, /data-testid="settlement-evidence"/);
  assert.match(html, /Outcome/);
  assert.match(html, /NO/);
  assert.match(html, /99\.00%/);
  assert.match(html, new RegExp(FIXTURE_DIGEST));
  assert.match(html, /Digest match verifies these bytes against the recorded commitment/);

  // Native file input plus a described-by help text: usable from the keyboard.
  assert.match(html, /type="file"/);
  assert.match(html, /aria-describedby="evidence-file-help"/);
  assert.match(html, /id="evidence-file-help"/);
  assert.match(html, /never uploaded/);
});

test('a refundable market explains that settlement evidence is not expected', async t => {
  const server = await createServer({
    root: frontendRoot,
    logLevel: 'silent',
    appType: 'custom',
    server: {middlewareMode: true},
  });
  t.after(() => server.close());

  const {default: MarketDetailPage} = await server.ssrLoadModule('/src/components/MarketDetailPage.jsx');
  const refundable = {...settledMarket(), status: 3, deadline: 1793201190n};
  const html = renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      {initialEntries: [{pathname: '/event/refund', hash: '#996', search: ''}]},
      React.createElement(MarketDetailPage, {
        markets: [refundable],
        positions: {},
        now: 1793201200,
        contractId: FIXTURE_CONTRACT,
      }),
    ),
  );

  assert.match(html, /Refund path/);
  assert.match(html, /does not require settlement evidence/);
  assert.doesNotMatch(html, /type="file"/);
});


test('market detail shows seven-decimal pool amounts separately from pool shares and legacy payout', async t => {
  const server = await createServer({root: frontendRoot, logLevel: 'silent', appType: 'custom', server: {middlewareMode: true}});
  t.after(() => server.close());
  const {default: MarketDetailPage} = await server.ssrLoadModule('/src/components/MarketDetailPage.jsx');
  const market = {
    id: 1, question: 'Pool display regression fixture', kind: 'Event', asset: null,
    threshold: 0n, closes_at: 2000n, deadline: 3000n, status: 0,
    yes_pool: 900_000_000n, no_pool: 100_000_000n, outcome: 0,
    confidence: 0, evidence: new Uint8Array(32),
  };
  const html = renderToStaticMarkup(React.createElement(MemoryRouter,
    {initialEntries: [{pathname: '/event/pool', hash: '#1'}]},
    React.createElement(MarketDetailPage, {
      markets: [market], positions: {}, address: 'GUSER', authenticated: true,
      now: 1000, previewMode: false,
    })));
  assert.match(html, /YES pool/);
  assert.match(html, /90\.0000000 XLM/);
  assert.match(html, /90\.00%/);
  assert.match(html, /NO pool/);
  assert.match(html, /10\.0000000 XLM/);
  assert.match(html, /10\.00%/);
  assert.match(html, /Estimated payout \(legacy settlement\)/);
  assert.match(html, /11\.0000000 XLM/);
});

test('empty market detail keeps the empty pool state instead of inventing a 50 percent share', async t => {
  const server = await createServer({root: frontendRoot, logLevel: 'silent', appType: 'custom', server: {middlewareMode: true}});
  t.after(() => server.close());
  const {default: MarketDetailPage} = await server.ssrLoadModule('/src/components/MarketDetailPage.jsx');
  const market = {
    id: 1, question: 'Empty pool fixture', kind: 'Event', asset: null,
    threshold: 0n, closes_at: 2000n, deadline: 3000n, status: 0,
    yes_pool: 0n, no_pool: 0n, outcome: 0, confidence: 0, evidence: new Uint8Array(32),
  };
  const html = renderToStaticMarkup(React.createElement(MemoryRouter,
    {initialEntries: [{pathname: '/event/empty', hash: '#1'}]},
    React.createElement(MarketDetailPage, {markets: [market], positions: {}, now: 1000})));
  assert.match(html, /0\.0000000 XLM/);
  assert.match(html, />—</);
  assert.doesNotMatch(html, /50\.00%/);
});
