import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer as createHttpServer, request} from 'node:http';
import {Keypair} from '@stellar/stellar-sdk';
import {openStore} from '../backend/store.mjs';
import {createApi} from '../backend/app.mjs';

const listen = server => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

async function apiCall(origin, path, {method = 'GET', body, cookie, headers = {}} = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : {'Content-Type': 'application/json'}),
      ...(cookie ? {Cookie: cookie} : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: text ? JSON.parse(text) : null,
    setCookie: response.headers.get('set-cookie'),
  };
}

test('#81: one origin serves the SPA and /api while preserving Origin checks and the session cookie', async t => {
  const db = openStore(':memory:');
  let backendPort = 0;

  // Minimal stand-in for the committed nginx route: SPA fallback plus /api forwarding.
  const proxy = createHttpServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const upstream = request(
        {hostname: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers: req.headers},
        response => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({error: 'Upstream unavailable'}));
      });
      req.pipe(upstream);
      return;
    }
    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
    res.end('<!doctype html><html><body><div id="root"></div></body></html>');
  });

  const proxyPort = await listen(proxy);
  const origin = `http://127.0.0.1:${proxyPort}`;
  const backend = createApi({db, appOrigin: origin, rateLimit: 1000, now: () => 1000});
  backendPort = await listen(backend);

  t.after(async () => {
    await new Promise(resolve => { proxy.close(resolve); proxy.closeAllConnections?.(); });
    await new Promise(resolve => { backend.close(resolve); backend.closeAllConnections?.(); });
    db.close();
  });

  const ready = await apiCall(origin, '/ready');
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body, {status: 'ready', service: 'revmarket-api'});

  const unknown = await apiCall(origin, '/not-a-route', {headers: {Origin: origin}});
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.body, {error: 'Endpoint not found'});

  const spa = await fetch(`${origin}/event/example`);
  assert.equal(spa.status, 200);
  assert.match(await spa.text(), /<div id="root">/);

  const wallet = Keypair.random();
  const challenge = await apiCall(origin, '/auth/challenge', {
    method: 'POST',
    body: {wallet: wallet.publicKey()},
    headers: {Origin: origin},
  });
  assert.equal(challenge.status, 200);

  const verified = await apiCall(origin, '/auth/verify', {
    method: 'POST',
    body: {id: challenge.body.id, signature: Buffer.from(wallet.signMessage(challenge.body.message)).toString('base64')},
    headers: {Origin: origin},
  });
  assert.equal(verified.status, 200);
  assert.match(verified.setCookie, /Path=\/api/);
  const cookie = verified.setCookie.split(';')[0];

  const me = await apiCall(origin, '/me', {cookie, headers: {Origin: origin}});
  assert.equal(me.status, 200);
  assert.equal(me.body.wallet, wallet.publicKey());

  const mismatched = await apiCall(origin, '/logout', {
    method: 'POST',
    body: {},
    cookie,
    headers: {Origin: 'http://127.0.0.1:1'},
  });
  assert.equal(mismatched.status, 403);
  assert.deepEqual(mismatched.body, {error: 'Origin not allowed'});

  const logout = await apiCall(origin, '/logout', {method: 'POST', body: {}, cookie, headers: {Origin: origin}});
  assert.equal(logout.status, 200);
  assert.deepEqual(logout.body, {signedOut: true});
  assert.match(logout.setCookie, /Max-Age=0/);
});
