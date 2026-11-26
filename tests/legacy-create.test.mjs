import test from 'node:test';
import assert from 'node:assert/strict';
import {Account, Keypair, TransactionBuilder, nativeToScVal, xdr} from '@stellar/stellar-sdk';
import {createClient} from '../shared/stellar.mjs';
import {NATIVE_XLM_SAC, SEEDED_COLLATERAL_FIXTURES} from '../frontend/src/lib/backend.mjs';
import {
  LEGACY_CREATE_LIMITS,
  createdMarketId,
  describeEscrow,
  encodeDescription,
  prepareLegacyCreate,
  withLegacyArtwork,
} from '../frontend/src/lib/legacy-create.mjs';

const now = 1_800_000_000;
const closes = seconds => new Date((now + seconds) * 1000).toISOString();
const cid = 'bafybeihgxdzljxb26q6nf3r3eifqeedsvt2eubqtskghpme66cgjyw4fra';
const bytes = value => Buffer.byteLength(value, 'utf8');
const eventForm = overrides => ({kind: 'event', category: 'Sports', question: 'Will Team A win the final?', closes: closes(86_400), description: '', hasArtwork: true, ...overrides});
const priceForm = overrides => ({kind: 'price', category: 'Crypto', asset: 'BTC', target: '85000', closes: closes(86_400), description: '', hasArtwork: false, ...overrides});

// Instance storage of the deployed Testnet market contract CACP6QFW...HLIN, read with getLedgerEntries.
const deployedInstanceXdr = 'AAAABgAAAAAAAAABBP9AtrZ+ELB3D1RxeACCibOGHGFLlrQITbCvv8a6QMUAAAAUAAAAAQAAABMAAAAA4XekPBO2hRkGXgoBnHFUrxCH+38AdKWCoUEgwKKnCSIAAAABAAAAAgAAABAAAAABAAAAAQAAAA8AAAAGQ29uZmlnAAAAAAARAAAAAQAAAAIAAAAPAAAACHJlc29sdmVyAAAAEgAAAAAAAAAACRWUwsqmbHowrccSb2ZN3odcmNF42Cx3PHZI96bKvw8AAAAPAAAABXRva2VuAAAAAAAAEgAAAAHXkotywnA8z+r365/0701QSlWouXn8m0UOoshCtNHOYQAAABAAAAABAAAAAQAAAA8AAAAFQ291bnQAAAAAAAADAAAADg==';

test('event markets require artwork before any upload or signature, and never get an invented CID', () => {
  assert.throws(() => prepareLegacyCreate(eventForm({hasArtwork: false}), {now}), /Event markets need artwork/);
  const market = prepareLegacyCreate(eventForm(), {now});
  assert.throws(() => withLegacyArtwork(market, ''), /Event markets need artwork/);
  assert.equal(withLegacyArtwork(market, cid).imageCid, cid);
});

test('price markets can be created without artwork and send an empty image CID', () => {
  const market = withLegacyArtwork(prepareLegacyCreate(priceForm(), {now}), '');
  assert.equal(market.imageCid, '');
  assert.equal(market.priceAsset, 'BTC');
  assert.equal(market.threshold, 8_500_000_000_000n);
});

test('question byte limit is checked after the category tag, in UTF-8 bytes', () => {
  const fits = 'a'.repeat(LEGACY_CREATE_LIMITS.questionBytes - bytes('[Sports] '));
  assert.equal(bytes(prepareLegacyCreate(eventForm({question: fits}), {now}).question), 512);
  assert.throws(() => prepareLegacyCreate(eventForm({question: `${fits}a`}), {now}), /513 bytes with the \[Sports\] tag; the contract allows 512/);
  assert.throws(() => prepareLegacyCreate(eventForm({category: 'Food & Dining', question: 'a'.repeat(505)}), {now}), /521 bytes/);
  assert.throws(() => prepareLegacyCreate(eventForm({category: 'General', question: 'é'.repeat(300)}), {now}), /600 bytes; the contract allows 512/);
  assert.equal(prepareLegacyCreate(eventForm({category: 'General', question: 'é'.repeat(256)}), {now}).question, 'é'.repeat(256));
  assert.throws(() => prepareLegacyCreate(eventForm({question: ''}), {now}), /Enter a question/);
});

test('descriptions are encoded in full and rejected when the encoding exceeds the contract limit, never truncated', () => {
  const description = 'Resolves YES if the official league site lists Team A as winner of the final match on the close date.';
  assert.equal(encodeDescription(description), `desc:${encodeURIComponent(description)}`);
  assert.throws(() => prepareLegacyCreate(eventForm({description}), {now}), /Description needs 144 of 128 bytes/);
  assert.throws(() => prepareLegacyCreate(eventForm({description: 'x'.repeat(300)}), {now}), /Description needs 305 of 128 bytes/);
  const longest = 'x'.repeat(LEGACY_CREATE_LIMITS.descriptionBytes - bytes('desc:'));
  assert.equal(prepareLegacyCreate(eventForm({description: longest}), {now}).descriptionCid, `desc:${longest}`);
  assert.equal(prepareLegacyCreate(eventForm({description: ''}), {now}).descriptionCid, '');
});

test('close time must be in the future and at most 30 days ahead', () => {
  assert.equal(prepareLegacyCreate(eventForm({closes: closes(LEGACY_CREATE_LIMITS.closeHorizonSeconds)}), {now}).closesAt, now + 2_592_000);
  assert.throws(() => prepareLegacyCreate(eventForm({closes: closes(LEGACY_CREATE_LIMITS.closeHorizonSeconds + 1)}), {now}), /within 30 days/);
  assert.throws(() => prepareLegacyCreate(eventForm({closes: closes(0)}), {now}), /future closing time/);
  assert.throws(() => prepareLegacyCreate(eventForm({closes: ''}), {now}), /future closing time/);
});

test('price targets must be positive and assets limited to the contract list', () => {
  assert.throws(() => prepareLegacyCreate(priceForm({target: '0'}), {now}), /Price outside supported range/);
  assert.throws(() => prepareLegacyCreate(priceForm({target: '-5'}), {now}), /Invalid USD price/);
  assert.equal(prepareLegacyCreate(priceForm({target: '0.00000001'}), {now}).threshold, 1n);
  assert.throws(() => prepareLegacyCreate(priceForm({asset: 'SOL'}), {now}), /BTC, ETH or XLM/);
});

test('artwork CIDs longer than the contract limit are rejected', () => {
  const market = prepareLegacyCreate(eventForm(), {now});
  assert.throws(() => withLegacyArtwork(market, `bafy${'a'.repeat(125)}`), /Artwork CID is 129 bytes/);
});

test('the deployment collateral is read from the deployed contract config', async () => {
  const transport = {getContractData: async () => ({val: xdr.LedgerEntryData.fromXDR(deployedInstanceXdr, 'base64')})};
  const client = createClient({rpcUrl: 'https://rpc.invalid', contractId: 'CACP6QFWWZ7BBMDXB5KHC6AAQKE3HBQ4MFFZNNAIJWYK7P6GXJAMLHIN', transport});
  assert.equal(await client.deploymentToken(), NATIVE_XLM_SAC);
});

test('escrow shows the deployment token only; a fixture or unknown token never reads as XLM', () => {
  assert.equal(describeEscrow(NATIVE_XLM_SAC).label, 'XLM');
  assert.equal(describeEscrow(NATIVE_XLM_SAC).contractId, NATIVE_XLM_SAC);
  const fixture = SEEDED_COLLATERAL_FIXTURES[1].contractId;
  assert.notEqual(describeEscrow(fixture).label, 'XLM');
  assert.match(describeEscrow(fixture).label, /Unverified token/);
});

test('write tracks the signed transaction by its 64-character hex hash and returns the new market id', async () => {
  const creator = Keypair.random();
  const polled = [];
  const transport = {
    getAccount: async () => new Account(creator.publicKey(), '1'),
    prepareTransaction: async tx => tx,
    sendTransaction: async tx => ({status: 'PENDING', hash: Buffer.from(tx.hash()).toString('hex')}),
    getTransaction: async hash => {
      polled.push(hash);
      return {status: 'SUCCESS', returnValue: nativeToScVal(16, {type: 'u32'})};
    },
  };
  const sign = async (envelope, passphrase) => {
    const tx = TransactionBuilder.fromXDR(envelope, passphrase);
    tx.sign(creator);
    return tx.toXDR();
  };
  const client = createClient({rpcUrl: 'https://rpc.invalid', contractId: 'CACP6QFWWZ7BBMDXB5KHC6AAQKE3HBQ4MFFZNNAIJWYK7P6GXJAMLHIN', transport, pollIntervalMs: 0});
  const result = await client.write(creator.publicKey(), sign, 'count');
  assert.match(result.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(polled, [result.hash]);
  assert.equal(createdMarketId(result), 16);
});

test('a confirmed create receipt yields the new market id', () => {
  assert.equal(createdMarketId({hash: 'abc', value: 14}), 14);
  assert.equal(createdMarketId({hash: 'abc', value: 0}), 0);
  assert.throws(() => createdMarketId({hash: 'abc', value: null}), /no market id.*abc/);
});
