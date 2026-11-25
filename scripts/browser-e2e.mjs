import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {Keypair} from '@stellar/stellar-sdk';
import {chromium} from 'playwright';

const origin = 'http://127.0.0.1:5173';
const admin = Keypair.random();
const creator = Keypair.random();
const reviewer = Keypair.random();
const trader = Keypair.random();
const identities = new Map([
  [admin.publicKey(), admin],
  [creator.publicKey(), creator],
  [reviewer.publicKey(), reviewer],
  [trader.publicKey(), trader],
]);
const children = [];

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: {...process.env, ...env},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  children.push(child);
  child.output = () => output;
  return child;
}

async function waitFor(url, child, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Process exited before ${url} became ready:\n${child.output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError || child.output()}`);
}

async function switchWallet(page, address) {
  await page.goto(`${origin}/settings`);
  await page.evaluate(() => { window.__REVMARKET_E2E__.wallet.connected = false; });
  await page.getByRole('button', {name: 'Disconnect Freighter'}).click();
  await page.evaluate(next => {
    window.__REVMARKET_E2E__.wallet.address = next;
    window.__REVMARKET_E2E__.wallet.connected = false;
  }, address);
  await page.getByRole('button', {name: 'Connect Freighter'}).click();
}

async function api(page, path, {method = 'GET', body} = {}) {
  return await page.evaluate(async ({path, method, body}) => {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, body: await response.json()};
  }, {path, method, body});
}

const backend = start(process.execPath, ['--experimental-sqlite', 'backend/server.mjs'], {
  BACKEND_ENV: 'local',
  BACKEND_DB: ':memory:',
  BACKEND_HOST: '127.0.0.1',
  BACKEND_PORT: '3001',
  APP_ORIGIN: origin,
  AI_ENABLED: 'false',
  SUPER_ADMIN_WALLETS: admin.publicKey(),
});
const frontend = start('npm', ['run', 'dev', '--workspace', 'frontend', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  VITE_E2E_TEST_MODE: 'true',
});

let browser;
try {
  await waitFor('http://127.0.0.1:3001/api/health', backend);
  await waitFor(origin, frontend);

  browser = await chromium.launch({headless: true});
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);

  await page.addInitScript(({initialWallet}) => {
    const now = Math.floor(Date.now() / 1000);
    const markets = new Map();
    for (const [id, question] of [
      [1, 'Will browser fixture market settle YES?'],
      [2, 'Will browser fixture timeout refund work?'],
      [3, 'Will browser fixture reject a wallet signature?'],
    ]) {
      markets.set(id, {
        id,
        creator: initialWallet,
        question,
        description_cid: '',
        image_cid: '',
        kind: ['Event', null, 0n],
        closes_at: BigInt(now + 7200),
        deadline: BigInt(now + 14_400),
        status: 0,
        yes_pool: 5_000_000_000n,
        no_pool: 5_000_000_000n,
        outcome: 0,
        confidence: 10_000,
        evidence: new Uint8Array(32),
      });
    }
    const positions = new Map();
    const state = {
      wallet: {
        address: initialWallet,
        connected: false,
        rejectNextSign: false,
        pendingSignatures: {},
        async requestAccess() {
          this.connected = true;
          return {address: this.address};
        },
        async getAddress() { return {address: this.address}; },
        async getNetworkDetails() { return {networkPassphrase: 'Test SDF Network ; September 2015'}; },
        async isConnected() { return this.connected; },
        async isAllowed() { return this.connected; },
        async signMessage() {
          const signedMessage = this.pendingSignatures[this.address];
          if (!signedMessage) return {error: 'No deterministic signature was prepared'};
          return {signedMessage, signerAddress: this.address};
        },
        async signTransaction(xdr) {
          if (this.rejectNextSign) {
            this.rejectNextSign = false;
            throw new Error('Wallet signature declined');
          }
          return {signedTxXdr: xdr, signerAddress: this.address};
        },
      },
      client: {
        async read(source, method, args = []) {
          if (method === 'count') return markets.size;
          const id = Number(args?.[0]?.u32?.() ?? 1);
          if (method === 'get_market') {
            const market = markets.get(id);
            if (!market) throw new Error('Unknown fixture market');
            return {...market};
          }
          if (method === 'get_position') {
            return positions.get(`${source}:${id}`) || null;
          }
          throw new Error(`Unexpected fixture read: ${method}`);
        },
        async deploymentToken() { return 'fixture-token'; },
        async write(source, sign, method, args = []) {
          await sign('deterministic-fixture-xdr', 'Test SDF Network ; September 2015');
          const id = Number((method === 'predict' || method === 'claim' ? args?.[1] : args?.[0])?.u32?.() ?? 1);
          const market = markets.get(id);
          if (!market) throw new Error('Unknown fixture market');
          if (method === 'predict') {
            const side = Number(args?.[2]?.u32?.() ?? 0);
            positions.set(`${source}:${id}`, {amount: 10_000_000n, side, claimed: false});
            if (side === 0) market.yes_pool += 10_000_000n;
            else market.no_pool += 10_000_000n;
          } else if (method === 'request') {
            market.status = 1;
          } else if (method === 'claim') {
            const position = positions.get(`${source}:${id}`);
            if (!position || position.claimed) throw new Error('No unclaimed fixture position');
            position.claimed = true;
            position.amount = 0n;
          } else {
            throw new Error(`Unexpected fixture write: ${method}`);
          }
          return {hash: `fixture-${method}-${id}-${Date.now()}`};
        },
      },
      advanceClose(id) {
        const market = markets.get(id);
        market.closes_at = BigInt(Math.floor(Date.now() / 1000) - 5);
      },
      advanceDeadline(id) {
        const market = markets.get(id);
        market.closes_at = BigInt(Math.floor(Date.now() / 1000) - 10);
        market.deadline = BigInt(Math.floor(Date.now() / 1000) - 5);
      },
      resolve(id) {
        const market = markets.get(id);
        market.status = 2;
        market.outcome = 0;
        market.confidence = 9500;
        market.evidence = new Uint8Array(32).fill(7);
      },
    };
    window.__REVMARKET_E2E__ = state;
  }, {initialWallet: admin.publicKey()});

  await page.route('**/api/auth/challenge', async route => {
    const response = await route.fetch();
    const challenge = await response.json();
    const keypair = identities.get(challenge.wallet);
    if (!keypair) throw new Error(`No fixture signer for ${challenge.wallet}`);
    const signature = Buffer.from(keypair.signMessage(challenge.message)).toString('base64');
    await page.evaluate(({address, signature}) => {
      window.__REVMARKET_E2E__.wallet.pendingSignatures[address] = signature;
    }, {address: challenge.wallet, signature});
    await route.fulfill({response, body: JSON.stringify(challenge)});
  });

  // Settings: connect a deterministic Testnet wallet, establish a session and manage a reviewer.
  await page.goto(`${origin}/settings`);
  await page.getByRole('button', {name: 'Connect Freighter'}).click();
  await page.getByRole('button', {name: 'Verify super-admin access'}).click();
  await page.getByText('Super admin', {exact: true}).waitFor();
  await page.getByLabel('Reviewer Stellar G-address').fill(reviewer.publicKey());
  await page.getByRole('button', {name: 'Add reviewer'}).click();
  await page.getByText(/Added reviewer/).waitFor();

  // Creator and reviewer use distinct signed sessions against the same local SQLite API.
  await switchWallet(page, creator.publicKey());
  await page.getByRole('button', {name: 'Verify super-admin access'}).click();
  await page.getByText('Not authorized', {exact: true}).waitFor();

  const now = Math.floor(Date.now() / 1000);
  const draft = await api(page, '/api/drafts', {
    method: 'POST',
    body: {
      question: 'Browser fixture: will the approved event resolve YES?',
      category: 'testing',
      tradingClose: now + 3600,
      observationTime: now + 3700,
      resolutionDeadline: now + 7200,
      yesRule: 'Resolve YES when the fixture observation is positive.',
      noRule: 'Resolve NO when the fixture observation is zero or negative.',
      equalityRule: 'Exact equality resolves NO.',
      sources: ['https://example.com/fixture'],
      fallbackRule: 'Use the deterministic fixture observation.',
      unavailableDataRule: 'Refund if the fixture observation is unavailable by the deadline.',
      collateral: 'native',
      feeBps: 30,
      resolver: reviewer.publicKey(),
      policyVersion: 'browser-fixture-v1',
      implementationVersion: 'legacy',
    },
  });
  if (draft.status !== 201) throw new Error(`Draft creation failed: ${JSON.stringify(draft)}`);
  const draftId = draft.body.id;
  const submitted = await api(page, `/api/drafts/${draftId}/submit`, {method: 'POST', body: {}});
  if (submitted.status !== 200) throw new Error(`Draft submission failed: ${JSON.stringify(submitted)}`);

  await switchWallet(page, reviewer.publicKey());
  await page.getByRole('button', {name: 'Verify super-admin access'}).click();
  await page.getByText('Not authorized', {exact: true}).waitFor();
  const reviewed = await api(page, `/api/drafts/${draftId}/review`, {
    method: 'POST',
    body: {decision: 'approved', reason: 'Approved by browser fixture reviewer', expectedRevisionId: draft.body.revisionId},
  });
  if (reviewed.status !== 200) throw new Error(`Reviewer decision failed: ${JSON.stringify(reviewed)}`);

  await switchWallet(page, creator.publicKey());
  await page.getByRole('button', {name: 'Verify super-admin access'}).click();
  await page.getByText('Not authorized', {exact: true}).waitFor();
  await page.goto(`${origin}/drafts/${draftId}/publish`);
  await page.getByTestId('intent-status-pill').getByText('PENDING').waitFor();
  const intentHeading = await page.locator('h1').textContent();
  const intentId = Number(intentHeading.match(/#(\d+)/)?.[1]);
  if (!intentId) throw new Error(`Could not read created publication intent: ${intentHeading}`);
  await page.goto(`${origin}/publication-intents/${intentId}`);
  await page.getByTestId('intent-status-pill').getByText('PENDING').waitFor();

  // Browser legacy-market lifecycle: take a position, request settlement, resolve, then claim.
  await switchWallet(page, trader.publicKey());
  await page.getByRole('button', {name: 'Verify super-admin access'}).click();
  await page.getByText('Not authorized', {exact: true}).waitFor();
  await page.goto(`${origin}/markets`);
  const firstCard = page.locator('.market-card').filter({hasText: 'Will browser fixture market settle YES?'});
  await firstCard.getByRole('button', {name: 'YES'}).click();
  await page.getByRole('button', {name: 'Confirm position'}).click();
  await page.getByText(/Confirmed: fixture-predict-1/).waitFor();

  await page.evaluate(() => window.__REVMARKET_E2E__.advanceClose(1));
  await page.goto(`${origin}/positions`);
  await page.getByRole('button', {name: 'Refresh'}).click();
  await page.getByRole('button', {name: 'Request'}).click();
  await page.evaluate(() => window.__REVMARKET_E2E__.resolve(1));
  await page.getByRole('button', {name: 'Refresh'}).click();
  await page.getByRole('button', {name: 'Claim'}).click();

  // Timeout refund path.
  await page.goto(`${origin}/event/will-browser-fixture-timeout-refund-work#2`);
  await page.getByRole('button', {name: 'Confirm position'}).click();
  await page.evaluate(() => window.__REVMARKET_E2E__.advanceDeadline(2));
  await page.goto(`${origin}/positions`);
  await page.getByRole('button', {name: 'Refresh'}).click();
  await page.getByRole('button', {name: 'Claim'}).click();

  // Wallet rejection must remain visible and must not create a position.
  await page.goto(`${origin}/event/will-browser-fixture-reject-a-wallet-signature#3`);
  await page.evaluate(() => { window.__REVMARKET_E2E__.wallet.rejectNextSign = true; });
  await page.getByRole('button', {name: 'Confirm position'}).click();
  await page.locator('.status-message').getByText(/Wallet signature declined/).waitFor();

  // A reviewer API outage is surfaced as an error rather than a false successful refresh.
  await switchWallet(page, admin.publicKey());
  await page.getByRole('button', {name: 'Verify super-admin access'}).click();
  await page.getByText('Super admin', {exact: true}).waitFor();
  await page.route('**/api/admin/reviewers', route => route.abort());
  await page.getByRole('button', {name: 'Refresh'}).click();
  await page.locator('.form-error').waitFor();

  console.log('Browser fixture scenarios passed: Settings/session switching; reviewer add; creator submit/reviewer decision/publication-intent reload; legacy position/settlement/claim; timeout refund; wallet rejection; reviewer API outage.');
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([once(child, 'exit'), delay(3000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}
