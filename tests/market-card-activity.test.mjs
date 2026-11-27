import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {fileURLToPath} from 'node:url';

const frontendRoot = fileURLToPath(new URL('../frontend', import.meta.url));
const market = overrides => ({
  id: 1, question: 'Fixture market question', kind: 'Event', asset: null,
  closes_at: 2_000_000_000n, deadline: 2_000_000_100n, status: 0,
  yes_pool: 900_000_000n, no_pool: 100_000_000n, ...overrides,
});

async function renderCard(t, value) {
  const server = await createServer({root: frontendRoot, logLevel: 'silent', appType: 'custom', server: {middlewareMode: true}});
  t.after(() => server.close());
  const {default: MarketCard} = await server.ssrLoadModule('/src/components/MarketCard.jsx');
  return renderToStaticMarkup(React.createElement(MemoryRouter, null,
    React.createElement(MarketCard, {market: value, now: 1_900_000_000, variant: 'live'})));
}

test('event-less live cards do not invent a trader or relative activity time', async t => {
  const html = await renderCard(t, market({creator: 'GCREATORADDRESS'}));
  assert.doesNotMatch(html, /Trader|GCREATORADDRESS|4s ago|live-card-activity-row/);
});

test('fixture activity keeps its fixture source label', async t => {
  const html = await renderCard(t, market({latest_activity: {source: 'fixture', sourceLabel: 'FIXTURE', user: 'GUSERADDRESS', timeAgo: '2m ago'}}));
  assert.match(html, /GUSE…DRESS/);
  assert.match(html, /2m ago/);
  assert.match(html, /FIXTURE/);
});

test('confirmed chain activity uses the attributable actor and event timestamp', async t => {
  const html = await renderCard(t, market({latest_activity: {verification: 'confirmed_chain_event', user: 'GUSERADDRESS', timestamp: 1_899_999_940}}));
  assert.match(html, /GUSE…DRESS/);
  assert.match(html, /1m ago/);
  assert.match(html, /ON-CHAIN/);
});

test('live cards label pool ratios as shares rather than executable prices', async t => {
  const html = await renderCard(t, market());
  assert.match(html, /YES POOL SHARE/);
  assert.match(html, /90%/);
  assert.doesNotMatch(html, /90¢|YES PRICE/);
});

test('empty live cards do not invent a fifty-cent quote', async t => {
  const html = await renderCard(t, market({yes_pool: 0n, no_pool: 0n}));
  assert.match(html, /YES POOL SHARE/);
  assert.match(html, /—/);
  assert.doesNotMatch(html, /50¢|50%/);
});
