import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(`${repoRoot}${path}`, 'utf8');

test('#81: the repo-owned nginx route serves the SPA and forwards /api on one origin', async () => {
  const nginx = await read('deploy/staging/nginx.conf');
  assert.match(nginx, /location \/api\//);
  assert.match(nginx, /proxy_pass http:\/\/api:3001;/);
  assert.match(nginx, /proxy_set_header Host \$http_host;/);
  assert.match(nginx, /proxy_set_header Origin \$http_origin;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto \$scheme;/);
  assert.match(nginx, /try_files \$uri \$uri\/ \/index\.html;/);
  assert.match(nginx, /location = \/index\.html/);
  assert.doesNotMatch(nginx, /proxy_hide_header Set-Cookie/i);
  assert.doesNotMatch(nginx, /proxy_cookie_path/i);
});

test('#81: compose runs the web route and mounts the built frontend plus nginx.conf', async () => {
  const compose = await read('deploy/staging/docker-compose.yml');
  assert.match(compose, /^  web:$/m);
  assert.match(compose, /image: nginx:1\.27-alpine/);
  assert.match(compose, /\.\/nginx\.conf:\/etc\/nginx\/conf\.d\/default\.conf:ro/);
  assert.match(compose, /\.\.\/\.\.\/frontend\/dist:\/usr\/share\/nginx\/html:ro/);
  assert.match(compose, /\$\{STAGING_HTTP_PORT:-8080\}:80/);
  assert.match(compose, /condition: service_healthy/);
});

test('#81: the staging runbook documents the exact origin, deep links, readiness and config boundaries', async () => {
  const staging = await read('docs/STAGING.md');
  assert.match(staging, /Option C: One-origin built SPA/);
  assert.match(staging, /npm ci/);
  assert.match(staging, /npm run build/);
  assert.match(staging, /APP_ORIGIN=http:\/\/localhost:8080/);
  assert.match(staging, /localhost` and `127\.0\.0\.1` are different origins|localhost.*127\.0\.0\.1.*different origins/s);
  assert.match(staging, /\/api\/ready/);
  assert.match(staging, /\/api\/not-a-route/);
  assert.match(staging, /\/settings/);
  assert.match(staging, /\/event\/example/);
  assert.match(staging, /Origin not allowed/);
  assert.match(staging, /VITE_\*/);
  assert.match(staging, /PINATA_JWT/);
  assert.match(staging, /VITE_PRIVY_APP_ID/);
  assert.match(staging, /No live hosting purchase is required/);
});
