import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Asset, Keypair, Networks, StrKey} from '@stellar/stellar-sdk';
import {openStore} from '../backend/store.mjs';
import {createApi} from '../backend/app.mjs';
import {
  DUPLICATE_CODE_FIXTURES,
  LEGACY_NATIVE_FIXTURE,
  MAINNET_NATIVE_XLM_SAC,
  NATIVE_XLM_SAC,
  SEEDED_COLLATERAL_FIXTURES,
  SYNTHETIC_REVTEST_ISSUERS,
  WRONG_NETWORK_FIXTURES,
  buildDraftReviewSummary,
  createDraft,
  deriveCollateralContractId,
  getCollateralCatalog,
  getDraft,
  parseSep11Asset,
  pinCollateralForDraft,
  resolveCollateralIdentity,
  resolveModalCollateralConfig,
  updateDraft,
  verifyCollateralAsset,
} from '../frontend/src/lib/backend.mjs';

const origin = 'http://127.0.0.1:5173';

async function apiFixture(t) {
  const db = openStore(':memory:');
  let clock = 1000;
  const admin = Keypair.random();
  const server = createApi({
    db,
    appOrigin: origin,
    now: () => clock,
    rateLimit: 1000,
    superAdminWallets: [admin.publicKey()],
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;
  let activeCookie = '';

  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' && input.startsWith('/api')
      ? base + input
      : input;
    const headers = new Headers(init.headers || {});
    if (!headers.has('Origin')) headers.set('Origin', origin);
    if (activeCookie && !headers.has('Cookie')) headers.set('Cookie', activeCookie);
    return originalFetch(url, {...init, headers});
  };

  t.after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    db.close();
  });

  async function call(path, {method = 'GET', body, cookie} = {}) {
    const headers = {Origin: origin};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (cookie) headers.Cookie = cookie;
    const response = await originalFetch(base + '/api' + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: await response.json(),
      cookie: response.headers.get('set-cookie')?.split(';')[0],
    };
  }

  async function login(keypair) {
    const challenge = await call('/auth/challenge', {
      method: 'POST',
      body: {wallet: keypair.publicKey()},
    });
    const verified = await call('/auth/verify', {
      method: 'POST',
      body: {
        id: challenge.body.id,
        signature: Buffer.from(keypair.signMessage(challenge.body.message)).toString('base64'),
      },
    });
    return verified.cookie;
  }

  return {
    db,
    admin,
    call,
    login,
    setCookie(cookie) {
      activeCookie = cookie;
    },
  };
}

test('SEP-11 parser and Testnet SAC derivation produce verified contract addresses', () => {
  const nativeParsed = parseSep11Asset('native');
  assert.equal(nativeParsed.sep11, 'native');
  assert.equal(nativeParsed.code, 'XLM');
  assert.equal(nativeParsed.issuer, null);
  assert.equal(nativeParsed.isNative, true);
  assert.equal(
    deriveCollateralContractId('native', Networks.TESTNET),
    Asset.native().contractId(Networks.TESTNET),
  );
  assert.equal(
    NATIVE_XLM_SAC,
    'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  );

  const [issuerA, issuerB] = SYNTHETIC_REVTEST_ISSUERS;
  assert.notEqual(issuerA, issuerB);
  assert.ok(StrKey.isValidEd25519PublicKey(issuerA));
  assert.ok(StrKey.isValidEd25519PublicKey(issuerB));

  const sacA = deriveCollateralContractId(`REVTEST:${issuerA}`, Networks.TESTNET);
  const sacB = deriveCollateralContractId(`REVTEST:${issuerB}`, Networks.TESTNET);
  assert.ok(StrKey.isValidContract(sacA));
  assert.ok(StrKey.isValidContract(sacB));
  assert.notEqual(sacA, sacB);
  assert.equal(sacA, new Asset('REVTEST', issuerA).contractId(Networks.TESTNET));
  assert.equal(sacB, new Asset('REVTEST', issuerB).contractId(Networks.TESTNET));

  assert.throws(() => parseSep11Asset(''), /Invalid SEP-11/);
  assert.throws(() => parseSep11Asset('REVTEST'), /Invalid SEP-11/);
  assert.throws(() => parseSep11Asset('REVTEST:NOT_A_G_ADDR'), /Invalid SEP-11 asset issuer/);
  assert.throws(() => parseSep11Asset(`TOOLONGCODE13:${issuerA}`), /Invalid SEP-11 asset code/);
  assert.throws(() => parseSep11Asset(`REV-TEST:${issuerA}`), /Invalid SEP-11 asset code/);
});

test('duplicate-code REVTEST fixtures display distinct issuer identities and only appear in explicit fixture mode', () => {
  const normalCatalog = getCollateralCatalog({fixtureMode: false});
  assert.equal(normalCatalog.length, 1);
  assert.equal(normalCatalog[0].code, 'XLM');
  assert.equal(normalCatalog[0].sep11, 'native');
  assert.equal(normalCatalog[0].contractId, NATIVE_XLM_SAC);
  assert.equal(normalCatalog[0].fixture, false);

  // Synthetic fixture assets must not leak into normal Testnet mode even if passed in allowlist
  const filteredNormal = getCollateralCatalog({
    fixtureMode: false,
    allowlist: [`REVTEST:${SYNTHETIC_REVTEST_ISSUERS[0]}`],
  });
  assert.equal(filteredNormal.length, 1);
  assert.equal(filteredNormal[0].contractId, NATIVE_XLM_SAC);

  // Explicit verified Testnet allowlist entry is shown in normal Testnet mode
  const customIssuer = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(0x33));
  const configuredCatalog = getCollateralCatalog({
    fixtureMode: false,
    allowlist: [`USDTEST:${customIssuer}`],
  });
  assert.equal(configuredCatalog.length, 2);
  assert.equal(configuredCatalog[1].code, 'USDTEST');
  assert.equal(configuredCatalog[1].issuer, customIssuer);
  assert.equal(
    configuredCatalog[1].contractId,
    new Asset('USDTEST', customIssuer).contractId(Networks.TESTNET),
  );

  // Explicit fixture mode includes native XLM and both 7-decimal synthetic REVTEST entries
  const fixtureCatalog = getCollateralCatalog({fixtureMode: true});
  assert.equal(fixtureCatalog.length, 3);
  assert.deepEqual(
    fixtureCatalog.map(entry => entry.code),
    ['XLM', 'REVTEST', 'REVTEST'],
  );

  const [, revA, revB] = fixtureCatalog;
  assert.equal(revA.decimals, 7);
  assert.equal(revB.decimals, 7);
  assert.equal(revA.fixture, true);
  assert.equal(revB.fixture, true);
  assert.equal(revA.network, 'testnet');
  assert.equal(revB.network, 'testnet');
  assert.match(revA.networkLabel, /Testnet fixture/);
  assert.match(revB.networkLabel, /Testnet fixture/);
  assert.notEqual(revA.issuer, revB.issuer);
  assert.notEqual(revA.issuerShort, revB.issuerShort);
  assert.notEqual(revA.optionLabel, revB.optionLabel);
  assert.notEqual(revA.contractId, revB.contractId);
  assert.equal(
    pinCollateralForDraft(revA.contractId, {fixtureMode: true}),
    revA.contractId,
  );
  assert.equal(
    pinCollateralForDraft(revB.contractId, {fixtureMode: true}),
    revB.contractId,
  );
});

test('wrong-network, mainnet SACs, and non-7-decimal collateral entries are rejected and never silently replaced', () => {
  assert.throws(
    () => deriveCollateralContractId('native', Networks.PUBLIC),
    err => err.code === 'WRONG_NETWORK',
  );
  assert.throws(
    () => verifyCollateralAsset(WRONG_NETWORK_FIXTURES.mainnetNative),
    err => err.code === 'WRONG_NETWORK',
  );
  assert.throws(
    () => verifyCollateralAsset(WRONG_NETWORK_FIXTURES.mainnetRevtestA),
    err => err.code === 'WRONG_NETWORK',
  );
  assert.throws(
    () => verifyCollateralAsset({
      sep11: `REVTEST:${SYNTHETIC_REVTEST_ISSUERS[0]}`,
      contractId: WRONG_NETWORK_FIXTURES.mainnetRevtestA.contractId,
    }),
    err => err.code === 'WRONG_NETWORK',
  );
  assert.throws(
    () => verifyCollateralAsset({
      sep11: 'native',
      decimals: 6,
    }),
    err => err.code === 'INVALID_DECIMALS',
  );

  // A draft containing a Mainnet SAC C-address is labeled as wrong_network and cannot be pinned
  const wrongNetResolved = resolveCollateralIdentity(
    WRONG_NETWORK_FIXTURES.mainnetRevtestA.contractId,
    {fixtureMode: true},
  );
  assert.equal(wrongNetResolved.status, 'wrong_network');
  assert.equal(wrongNetResolved.available, false);
  assert.equal(wrongNetResolved.pinnedContractId, null);
  assert.match(wrongNetResolved.optionLabel, /Unavailable.*Wrong network/i);

  assert.throws(
    () => pinCollateralForDraft(WRONG_NETWORK_FIXTURES.mainnetRevtestA.contractId, {fixtureMode: true}),
    err => err.code === 'WRONG_NETWORK' && /cannot be silently replaced/i.test(err.message),
  );
  assert.throws(
    () => pinCollateralForDraft(MAINNET_NATIVE_XLM_SAC, {fixtureMode: false}),
    err => err.code === 'WRONG_NETWORK',
  );
});

test('removed or unavailable collateral entries are labeled and cannot be silently replaced; legacy native stays readable', () => {
  const revtestA = SEEDED_COLLATERAL_FIXTURES[1];

  // When fixtureMode is false, a previously saved REVTEST C-address is unavailable/removed
  const removedIdentity = resolveCollateralIdentity(revtestA.contractId, {fixtureMode: false});
  assert.equal(removedIdentity.status, 'removed');
  assert.equal(removedIdentity.available, false);
  assert.equal(removedIdentity.code, 'REVTEST');
  assert.equal(removedIdentity.issuer, revtestA.issuer);
  assert.equal(removedIdentity.storedCollateral, revtestA.contractId);
  assert.equal(removedIdentity.pinnedContractId, null);
  assert.match(removedIdentity.optionLabel, /Unavailable — REVTEST/);
  assert.match(removedIdentity.reason, /cannot be silently replaced/);

  assert.throws(
    () => pinCollateralForDraft(revtestA.contractId, {fixtureMode: false}),
    err => err.code === 'UNAVAILABLE_COLLATERAL' && /cannot be silently replaced/.test(err.message),
  );

  // Unknown arbitrary C-address is also labeled unavailable and rejected on pin
  const unknownContract = new Asset('UNKNOWN', Keypair.random().publicKey()).contractId(Networks.TESTNET);
  const unknownIdentity = resolveCollateralIdentity(unknownContract, {fixtureMode: false});
  assert.equal(unknownIdentity.status, 'unavailable');
  assert.equal(unknownIdentity.available, false);
  assert.throws(
    () => pinCollateralForDraft(unknownContract, {fixtureMode: false}),
    err => err.code === 'UNAVAILABLE_COLLATERAL',
  );

  // Legacy 'native' draft value stays readable and maps to Testnet XLM SAC
  const legacySummary = buildDraftReviewSummary(LEGACY_NATIVE_FIXTURE, {fixtureMode: false});
  assert.equal(legacySummary.status, 'legacy');
  assert.equal(legacySummary.isAvailable, true);
  assert.equal(legacySummary.isLegacy, true);
  assert.equal(legacySummary.code, 'XLM');
  assert.equal(legacySummary.sep11, 'native');
  assert.equal(legacySummary.storedCollateral, 'native');
  assert.equal(legacySummary.pinnedContractId, NATIVE_XLM_SAC);
  assert.equal(legacySummary.assetDisplay, 'XLM');
  assert.match(legacySummary.warning, /legacy draft value "native" stays readable/i);
});

test('creator and reviewer see the exact same pinned collateral asset in the stored revision', async t => {
  const f = await apiFixture(t);
  const creator = Keypair.random();
  const reviewer = Keypair.random();
  const adminCookie = await f.login(f.admin);
  const creatorCookie = await f.login(creator);
  const reviewerCookie = await f.login(reviewer);

  await f.call('/admin/reviewers', {
    method: 'POST',
    cookie: adminCookie,
    body: {wallet: reviewer.publicKey(), action: 'add'},
  });

  const [, revA, revB] = DUPLICATE_CODE_FIXTURES;

  // Creator creates two drafts with the two distinct REVTEST assets sharing code REVTEST
  f.setCookie(creatorCookie);
  const draftA = await createDraft(
    {
      question: 'Will Soroban Testnet ledger close times stay below 6s (REVTEST Issuer A)?',
      category: 'Crypto',
      tradingClose: 2000,
      collateral: revA.contractId,
    },
    {fixtureMode: true},
  );
  const draftB = await createDraft(
    {
      question: 'Will Soroban Testnet ledger close times stay below 6s (REVTEST Issuer B)?',
      category: 'Crypto',
      tradingClose: 2000,
      collateral: revB.contractId,
    },
    {fixtureMode: true},
  );
  assert.notEqual(draftA.contentHash, draftB.contentHash);

  // Attempting to update draftA with a removed/inactive or wrong-network collateral fails closed
  await assert.rejects(
    () => updateDraft(
      draftA.id,
      {
        question: 'Attempt silent replacement',
        tradingClose: 2000,
        collateral: WRONG_NETWORK_FIXTURES.mainnetRevtestA.contractId,
      },
      {fixtureMode: true},
    ),
    err => err.code === 'WRONG_NETWORK',
  );
  await assert.rejects(
    () => updateDraft(
      draftA.id,
      {
        question: 'Attempt save when fixture mode disabled',
        tradingClose: 2000,
        collateral: revA.contractId,
      },
      {fixtureMode: false},
    ),
    err => err.code === 'UNAVAILABLE_COLLATERAL',
  );

  // Creator fetches stored draftA
  f.setCookie(creatorCookie);
  const creatorView = await getDraft(draftA.id);
  const creatorRevision = creatorView.revisions[0];
  assert.equal(creatorRevision.collateral, revA.contractId);

  // Reviewer fetches stored draftA
  f.setCookie(reviewerCookie);
  const reviewerView = await getDraft(draftA.id);
  const reviewerRevision = reviewerView.revisions[0];
  assert.equal(reviewerRevision.collateral, revA.contractId);

  const creatorSummary = buildDraftReviewSummary(creatorRevision, {fixtureMode: true});
  const reviewerSummary = buildDraftReviewSummary(reviewerRevision, {fixtureMode: true});
  assert.deepEqual(creatorSummary, reviewerSummary);
  assert.equal(reviewerSummary.code, 'REVTEST');
  assert.equal(reviewerSummary.issuer, revA.issuer);
  assert.equal(reviewerSummary.sep11, revA.sep11);
  assert.equal(reviewerSummary.pinnedContractId, revA.contractId);
  assert.equal(reviewerSummary.isFixture, true);
  assert.match(reviewerSummary.networkLabel, /Testnet fixture/);
});

test('CreateMarketModal configuration and review summary resolve normal Testnet, duplicate-code, wrong-network, removed, and legacy native states', async () => {
  const normalConfig = resolveModalCollateralConfig({search: ''});
  assert.equal(normalConfig.fixtureMode, false);
  assert.equal(normalConfig.catalog.length, 1);
  assert.equal(normalConfig.initialCollateral, NATIVE_XLM_SAC);
  const normalSummary = buildDraftReviewSummary(
    {collateral: normalConfig.initialCollateral},
    {fixtureMode: normalConfig.fixtureMode, catalog: normalConfig.catalog},
  );
  assert.equal(normalSummary.status, 'verified');
  assert.equal(normalSummary.assetDisplay, 'XLM');
  assert.equal(normalSummary.pinnedContractId, NATIVE_XLM_SAC);

  const duplicateCodeConfig = resolveModalCollateralConfig({search: '?fixture=duplicate-code'});
  assert.equal(duplicateCodeConfig.fixtureMode, true);
  assert.equal(duplicateCodeConfig.catalog.length, 3);
  assert.equal(duplicateCodeConfig.initialCollateral, DUPLICATE_CODE_FIXTURES[1].contractId);
  const duplicateSummary = buildDraftReviewSummary(
    duplicateCodeConfig.initialDraft,
    {fixtureMode: duplicateCodeConfig.fixtureMode, catalog: duplicateCodeConfig.catalog},
  );
  assert.equal(duplicateSummary.status, 'verified');
  assert.equal(duplicateSummary.code, 'REVTEST');
  assert.equal(duplicateSummary.issuer, DUPLICATE_CODE_FIXTURES[1].issuer);
  assert.equal(duplicateSummary.pinnedContractId, DUPLICATE_CODE_FIXTURES[1].contractId);
  assert.equal(duplicateSummary.isFixture, true);

  const wrongNetworkConfig = resolveModalCollateralConfig({search: '?fixture=wrong-network'});
  assert.equal(wrongNetworkConfig.fixtureMode, true);
  assert.equal(wrongNetworkConfig.initialCollateral, WRONG_NETWORK_FIXTURES.mainnetRevtestA.contractId);
  const wrongNetworkSummary = buildDraftReviewSummary(
    wrongNetworkConfig.initialDraft,
    {fixtureMode: wrongNetworkConfig.fixtureMode, catalog: wrongNetworkConfig.catalog},
  );
  assert.equal(wrongNetworkSummary.status, 'wrong_network');
  assert.equal(wrongNetworkSummary.isAvailable, false);
  assert.equal(wrongNetworkSummary.pinnedContractId, null);
  assert.match(wrongNetworkSummary.warning, /Wrong-network collateral/);

  const removedConfig = resolveModalCollateralConfig({search: '?fixture=removed'});
  assert.equal(removedConfig.fixtureMode, false);
  assert.equal(removedConfig.initialCollateral, DUPLICATE_CODE_FIXTURES[1].contractId);
  const removedSummary = buildDraftReviewSummary(
    removedConfig.initialDraft,
    {fixtureMode: removedConfig.fixtureMode, catalog: removedConfig.catalog},
  );
  assert.equal(removedSummary.status, 'removed');
  assert.equal(removedSummary.isAvailable, false);
  assert.equal(removedSummary.pinnedContractId, null);
  assert.match(removedSummary.warning, /removed or unavailable/);

  const legacyConfig = resolveModalCollateralConfig({search: '?fixture=legacy-native'});
  assert.equal(legacyConfig.fixtureMode, false);
  assert.equal(legacyConfig.initialCollateral, 'native');
  const legacySummary = buildDraftReviewSummary(
    legacyConfig.initialDraft,
    {fixtureMode: legacyConfig.fixtureMode, catalog: legacyConfig.catalog},
  );
  assert.equal(legacySummary.status, 'legacy');
  assert.equal(legacySummary.isAvailable, true);
  assert.equal(legacySummary.isLegacy, true);
  assert.equal(legacySummary.storedCollateral, 'native');
  assert.equal(legacySummary.pinnedContractId, NATIVE_XLM_SAC);

  const modalSource = await readFile(
    new URL('../frontend/src/components/CreateMarketModal.jsx', import.meta.url),
    'utf8',
  );
  assert.match(modalSource, /CollateralReviewSummary/);
  assert.match(modalSource, /pinCollateralForDraft/);
  assert.match(modalSource, /resolveCollateralIdentity/);
  assert.match(modalSource, /name="collateral"/);
});
