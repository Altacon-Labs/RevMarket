import {Asset, Networks, StrKey} from '@stellar/stellar-sdk';

export const TESTNET_PASSPHRASE = Networks.TESTNET;
export const NATIVE_XLM_SAC = Asset.native().contractId(Networks.TESTNET);
export const MAINNET_NATIVE_XLM_SAC = Asset.native().contractId(Networks.PUBLIC);
export const COLLATERAL_DECIMALS = 7;

function deterministicTestIssuer(fillByte) {
  return StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(fillByte));
}

export const SYNTHETIC_REVTEST_ISSUERS = Object.freeze([
  deterministicTestIssuer(0x11),
  deterministicTestIssuer(0x55),
]);

export function formatShortAddress(address, prefix = 8, suffix = 6) {
  if (typeof address !== 'string') return '';
  const trimmed = address.trim();
  if (trimmed.length <= prefix + suffix + 1) return trimmed;
  return `${trimmed.slice(0, prefix)}…${trimmed.slice(-suffix)}`;
}

function collateralError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function parseSep11Asset(sep11) {
  if (typeof sep11 !== 'string' || !sep11.trim()) {
    throw collateralError('INVALID_SEP11', 'Invalid SEP-11 asset identity; expected "native" or "CODE:ISSUER".');
  }
  const normalized = sep11.trim();
  if (normalized === 'native') {
    const asset = Asset.native();
    return {
      sep11: 'native',
      code: 'XLM',
      issuer: null,
      isNative: true,
      assetType: asset.getAssetType(),
      asset,
    };
  }
  const parts = normalized.split(':');
  if (parts.length !== 2) {
    throw collateralError('INVALID_SEP11', 'Invalid SEP-11 asset identity; expected "native" or "CODE:ISSUER".');
  }
  const [code, issuer] = parts;
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    throw collateralError('INVALID_SEP11_CODE', 'Invalid SEP-11 asset code; expected 1-12 alphanumeric ASCII characters.');
  }
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    throw collateralError('INVALID_SEP11_ISSUER', 'Invalid SEP-11 asset issuer; expected a valid Stellar G-address.');
  }
  const asset = new Asset(code, issuer);
  return {
    sep11: `${code}:${issuer}`,
    code,
    issuer,
    isNative: false,
    assetType: asset.getAssetType(),
    asset,
  };
}

export function deriveCollateralContractId(sep11, networkPassphrase = Networks.TESTNET) {
  if (networkPassphrase !== Networks.TESTNET) {
    throw collateralError('WRONG_NETWORK', 'Stellar Testnet network passphrase is required for collateral SAC derivation.');
  }
  const {asset} = parseSep11Asset(sep11);
  const contractId = asset.contractId(Networks.TESTNET);
  if (!StrKey.isValidContract(contractId)) {
    throw collateralError('INVALID_CONTRACT_ID', 'Derived Stellar Asset Contract address is invalid.');
  }
  return contractId;
}

export function verifyCollateralAsset(entry, {networkPassphrase = Networks.TESTNET} = {}) {
  if (networkPassphrase !== Networks.TESTNET) {
    throw collateralError('WRONG_NETWORK', 'Stellar Testnet network passphrase is required for collateral verification.');
  }
  if (!entry || (typeof entry !== 'string' && typeof entry !== 'object') || Array.isArray(entry)) {
    throw collateralError('INVALID_COLLATERAL_ENTRY', 'Collateral entry must be a SEP-11 asset string or configuration object.');
  }
  const isObject = typeof entry === 'object';
  if (isObject) {
    if (entry.network !== undefined && String(entry.network).toLowerCase() !== 'testnet') {
      throw collateralError('WRONG_NETWORK', 'Collateral asset must target Stellar Testnet; Mainnet assets are excluded.');
    }
    if (entry.networkPassphrase !== undefined && entry.networkPassphrase !== Networks.TESTNET) {
      throw collateralError('WRONG_NETWORK', 'Collateral asset must use the Stellar Testnet network passphrase.');
    }
    const decimals = entry.decimals === undefined ? COLLATERAL_DECIMALS : entry.decimals;
    if (decimals !== COLLATERAL_DECIMALS) {
      throw collateralError('INVALID_DECIMALS', 'Collateral asset must use 7-decimal Stellar precision.');
    }
  }

  let sep11Input;
  if (typeof entry === 'string') {
    sep11Input = entry;
  } else if (typeof entry.sep11 === 'string') {
    sep11Input = entry.sep11;
  } else if (entry.code === 'XLM' && (entry.issuer === null || entry.issuer === undefined)) {
    sep11Input = 'native';
  } else if (typeof entry.code === 'string' && typeof entry.issuer === 'string') {
    sep11Input = `${entry.code}:${entry.issuer}`;
  } else {
    throw collateralError('INVALID_SEP11', 'Collateral entry must specify a valid SEP-11 asset identity.');
  }

  const parsed = parseSep11Asset(sep11Input);
  if (isObject) {
    if (entry.code !== undefined && entry.code !== parsed.code) {
      throw collateralError('INVALID_SEP11', 'Collateral entry code does not match its SEP-11 identity.');
    }
    if (entry.issuer !== undefined && entry.issuer !== null && entry.issuer !== parsed.issuer) {
      throw collateralError('INVALID_SEP11', 'Collateral entry issuer does not match its SEP-11 identity.');
    }
  }

  const derivedContractId = parsed.asset.contractId(Networks.TESTNET);
  const mainnetContractId = parsed.asset.contractId(Networks.PUBLIC);

  if (isObject && entry.contractId !== undefined) {
    if (entry.contractId === mainnetContractId) {
      throw collateralError('WRONG_NETWORK', 'Mainnet Stellar Asset Contract address rejected; Stellar Testnet SAC required.');
    }
    if (!StrKey.isValidContract(entry.contractId) || entry.contractId !== derivedContractId) {
      throw collateralError('CONTRACT_MISMATCH', 'Collateral contract address does not match derived Testnet Stellar Asset Contract.');
    }
  }

  const isFixture = Boolean(
    (isObject && entry.fixture) ||
    (parsed.code === 'REVTEST' && SYNTHETIC_REVTEST_ISSUERS.includes(parsed.issuer))
  );
  const issuerShort = parsed.issuer ? formatShortAddress(parsed.issuer) : null;
  const contractShort = formatShortAddress(derivedContractId);
  const networkLabel = isFixture ? 'Testnet fixture' : 'Testnet';
  const displayLabel = parsed.isNative ? 'XLM' : `${parsed.code} (${issuerShort})`;
  const fullDisplayLabel = parsed.isNative ? 'XLM' : `${parsed.code} · ${parsed.issuer}`;
  const optionLabel = parsed.isNative
    ? 'XLM — Native (Testnet)'
    : `${parsed.code} — Issuer ${issuerShort} (${networkLabel})`;

  return Object.freeze({
    sep11: parsed.sep11,
    code: parsed.code,
    issuer: parsed.issuer,
    issuerShort,
    contractId: derivedContractId,
    contractShort,
    decimals: COLLATERAL_DECIMALS,
    isNative: parsed.isNative,
    fixture: isFixture,
    network: 'testnet',
    networkPassphrase: Networks.TESTNET,
    networkLabel,
    displayLabel,
    fullDisplayLabel,
    optionLabel,
  });
}

export const SEEDED_COLLATERAL_FIXTURES = Object.freeze([
  verifyCollateralAsset({sep11: 'native', decimals: COLLATERAL_DECIMALS, fixture: false}),
  verifyCollateralAsset({sep11: `REVTEST:${SYNTHETIC_REVTEST_ISSUERS[0]}`, decimals: COLLATERAL_DECIMALS, fixture: true}),
  verifyCollateralAsset({sep11: `REVTEST:${SYNTHETIC_REVTEST_ISSUERS[1]}`, decimals: COLLATERAL_DECIMALS, fixture: true}),
]);

export const DUPLICATE_CODE_FIXTURES = SEEDED_COLLATERAL_FIXTURES;

export const WRONG_NETWORK_FIXTURES = Object.freeze({
  mainnetNative: Object.freeze({
    sep11: 'native',
    code: 'XLM',
    issuer: null,
    decimals: COLLATERAL_DECIMALS,
    network: 'mainnet',
    networkPassphrase: Networks.PUBLIC,
    contractId: MAINNET_NATIVE_XLM_SAC,
  }),
  mainnetRevtestA: Object.freeze({
    sep11: `REVTEST:${SYNTHETIC_REVTEST_ISSUERS[0]}`,
    code: 'REVTEST',
    issuer: SYNTHETIC_REVTEST_ISSUERS[0],
    decimals: COLLATERAL_DECIMALS,
    network: 'mainnet',
    networkPassphrase: Networks.PUBLIC,
    contractId: new Asset('REVTEST', SYNTHETIC_REVTEST_ISSUERS[0]).contractId(Networks.PUBLIC),
  }),
  mainnetRevtestB: Object.freeze({
    sep11: `REVTEST:${SYNTHETIC_REVTEST_ISSUERS[1]}`,
    code: 'REVTEST',
    issuer: SYNTHETIC_REVTEST_ISSUERS[1],
    decimals: COLLATERAL_DECIMALS,
    network: 'mainnet',
    networkPassphrase: Networks.PUBLIC,
    contractId: new Asset('REVTEST', SYNTHETIC_REVTEST_ISSUERS[1]).contractId(Networks.PUBLIC),
  }),
});

export const LEGACY_NATIVE_FIXTURE = Object.freeze({
  id: 1,
  revisionId: 1,
  revisionNumber: 1,
  question: 'Will Soroban Testnet average ledger close time stay under 6 seconds this week?',
  category: 'Crypto',
  tradingClose: 1893456000,
  collateral: 'native',
  status: 'submitted',
});

export function parseConfiguredAllowlist(rawAllowlist) {
  if (Array.isArray(rawAllowlist)) return rawAllowlist;
  if (typeof rawAllowlist !== 'string' || !rawAllowlist.trim()) return [];
  const trimmed = rawAllowlist.trim();
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw collateralError('INVALID_COLLATERAL_ALLOWLIST', 'Collateral allowlist JSON must be an array.');
    }
    return parsed;
  }
  return trimmed
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

export function getCollateralCatalog({
  fixtureMode = false,
  allowlist,
  networkPassphrase = Networks.TESTNET,
} = {}) {
  if (networkPassphrase !== Networks.TESTNET) {
    throw collateralError('WRONG_NETWORK', 'Collateral catalog supports Stellar Testnet only.');
  }
  const base = fixtureMode
    ? [...SEEDED_COLLATERAL_FIXTURES]
    : [SEEDED_COLLATERAL_FIXTURES[0]];
  const rawAllowlist = allowlist !== undefined
    ? allowlist
    : (typeof import.meta !== 'undefined' && import.meta.env?.VITE_COLLATERAL_ALLOWLIST) || [];
  const configuredEntries = parseConfiguredAllowlist(rawAllowlist);

  for (const rawEntry of configuredEntries) {
    const verified = verifyCollateralAsset(rawEntry, {networkPassphrase});
    if (!fixtureMode && verified.fixture) {
      continue;
    }
    if (!base.some(existing => existing.contractId === verified.contractId)) {
      base.push(verified);
    }
  }
  return Object.freeze(base);
}

export function resolveCollateralIdentity(
  collateralValue,
  {
    fixtureMode = false,
    allowlist,
    catalog,
    knownAssets = [],
  } = {},
) {
  const activeCatalog = catalog || getCollateralCatalog({fixtureMode, allowlist});
  const raw = typeof collateralValue === 'string' ? collateralValue.trim() : '';

  if (raw === 'native' || raw === 'XLM') {
    const nativeEntry = SEEDED_COLLATERAL_FIXTURES[0];
    return Object.freeze({
      ...nativeEntry,
      status: 'legacy',
      available: true,
      legacy: true,
      storedCollateral: raw,
      pinnedContractId: NATIVE_XLM_SAC,
      networkLabel: 'Testnet · Legacy "native"',
      displayLabel: 'XLM',
      summaryLabel: `XLM (Legacy "${raw}" draft value)`,
      optionLabel: `XLM — Legacy "${raw}" draft value (Testnet SAC ${nativeEntry.contractShort})`,
      note: `Existing legacy draft value "${raw}" stays readable and maps to Testnet native XLM (${NATIVE_XLM_SAC}).`,
    });
  }

  const activeMatch = activeCatalog.find(entry => entry.contractId === raw || entry.sep11 === raw);
  if (activeMatch) {
    return Object.freeze({
      ...activeMatch,
      status: 'verified',
      available: true,
      legacy: false,
      storedCollateral: raw,
      pinnedContractId: activeMatch.contractId,
      summaryLabel: activeMatch.isNative ? 'XLM' : `${activeMatch.code} · ${activeMatch.issuer}`,
      note: activeMatch.fixture
        ? 'Synthetic 7-decimal Testnet fixture asset.'
        : 'Verified Stellar Testnet collateral asset.',
    });
  }

  const mainnetCandidates = [...Object.values(WRONG_NETWORK_FIXTURES)];
  for (const candidate of knownAssets) {
    try {
      const parsed = parseSep11Asset(typeof candidate === 'string' ? candidate : candidate?.sep11);
      mainnetCandidates.push({
        sep11: parsed.sep11,
        code: parsed.code,
        issuer: parsed.issuer,
        contractId: parsed.asset.contractId(Networks.PUBLIC),
      });
    } catch {}
  }
  const mainnetMatch = mainnetCandidates.find(item => item.contractId === raw);
  if (mainnetMatch) {
    const issuerShort = mainnetMatch.issuer ? formatShortAddress(mainnetMatch.issuer) : null;
    const contractShort = formatShortAddress(raw);
    return Object.freeze({
      status: 'wrong_network',
      available: false,
      legacy: false,
      sep11: mainnetMatch.sep11,
      code: mainnetMatch.code,
      issuer: mainnetMatch.issuer,
      issuerShort,
      contractId: raw,
      contractShort,
      pinnedContractId: null,
      storedCollateral: raw,
      decimals: COLLATERAL_DECIMALS,
      isNative: mainnetMatch.code === 'XLM' && !mainnetMatch.issuer,
      fixture: false,
      network: 'mainnet',
      networkLabel: 'Unavailable · Wrong network (Mainnet)',
      displayLabel: `Unavailable (${mainnetMatch.code}${issuerShort ? ` · ${issuerShort}` : ''} · Wrong network)`,
      summaryLabel: `Unavailable — ${mainnetMatch.code}${issuerShort ? ` (${issuerShort})` : ''} · Wrong network (Mainnet SAC)`,
      optionLabel: `Unavailable — ${mainnetMatch.code}${issuerShort ? ` · Issuer ${issuerShort}` : ''} (Wrong network: Mainnet SAC ${contractShort})`,
      reason: 'Wrong-network collateral: Mainnet Stellar Asset Contract address cannot be used on Stellar Testnet and cannot be silently replaced.',
    });
  }

  const inactiveCandidates = [...SEEDED_COLLATERAL_FIXTURES];
  for (const candidate of knownAssets) {
    try {
      inactiveCandidates.push(verifyCollateralAsset(candidate));
    } catch {}
  }
  let inactiveMatch = inactiveCandidates.find(entry => entry.contractId === raw || entry.sep11 === raw);
  if (!inactiveMatch && raw.includes(':')) {
    try {
      inactiveMatch = verifyCollateralAsset(raw);
    } catch {}
  }
  if (inactiveMatch) {
    return Object.freeze({
      ...inactiveMatch,
      status: 'removed',
      available: false,
      legacy: false,
      pinnedContractId: null,
      storedCollateral: raw,
      networkLabel: inactiveMatch.fixture
        ? 'Unavailable · Testnet fixture inactive'
        : 'Unavailable · Removed from allowlist',
      displayLabel: `Unavailable (${inactiveMatch.code}${inactiveMatch.issuerShort ? ` · ${inactiveMatch.issuerShort}` : ''})`,
      summaryLabel: `Unavailable — ${inactiveMatch.code}${inactiveMatch.issuer ? ` (${inactiveMatch.issuer})` : ''} · Removed or not in active allowlist`,
      optionLabel: `Unavailable — ${inactiveMatch.code}${inactiveMatch.issuerShort ? ` · Issuer ${inactiveMatch.issuerShort}` : ''} (Removed / not in active allowlist)`,
      reason: `Collateral ${inactiveMatch.code}${inactiveMatch.issuerShort ? ` (${inactiveMatch.issuerShort})` : ''} is removed or unavailable in the active Testnet allowlist and cannot be silently replaced.`,
    });
  }

  const isContract = StrKey.isValidContract(raw);
  const shortRaw = isContract ? formatShortAddress(raw) : (raw || 'empty');
  return Object.freeze({
    status: 'unavailable',
    available: false,
    legacy: false,
    sep11: null,
    code: null,
    issuer: null,
    issuerShort: null,
    contractId: isContract ? raw : null,
    contractShort: shortRaw,
    pinnedContractId: null,
    storedCollateral: raw,
    decimals: null,
    isNative: false,
    fixture: false,
    network: 'unknown',
    networkLabel: 'Unavailable · Unverified collateral',
    displayLabel: `Unavailable (${shortRaw})`,
    summaryLabel: `Unavailable — Unverified collateral (${raw || 'none'})`,
    optionLabel: `Unavailable — Unverified collateral (${shortRaw})`,
    reason: `Collateral "${raw || 'empty'}" is unavailable or unverified in the active Testnet allowlist and cannot be silently replaced.`,
  });
}

export function pinCollateralForDraft(collateralValue, options = {}) {
  const resolved = resolveCollateralIdentity(collateralValue, options);
  if (!resolved.available || !resolved.pinnedContractId) {
    throw collateralError(
      resolved.status === 'wrong_network' ? 'WRONG_NETWORK' : 'UNAVAILABLE_COLLATERAL',
      resolved.reason || 'Selected collateral is unavailable and cannot be silently replaced.',
    );
  }
  return resolved.pinnedContractId;
}

export function buildDraftReviewSummary(revisionOrDraft = {}, options = {}) {
  const hasExplicitCollateral = revisionOrDraft && revisionOrDraft.collateral !== undefined && revisionOrDraft.collateral !== null;
  const storedCollateral = hasExplicitCollateral ? String(revisionOrDraft.collateral) : NATIVE_XLM_SAC;
  const resolved = resolveCollateralIdentity(storedCollateral, options);
  return Object.freeze({
    draftId: revisionOrDraft?.draftId ?? revisionOrDraft?.id ?? null,
    revisionId: revisionOrDraft?.revisionId ?? revisionOrDraft?.id ?? null,
    revisionNumber: revisionOrDraft?.revisionNumber ?? 1,
    contentHash: revisionOrDraft?.contentHash ?? null,
    question: revisionOrDraft?.question ?? '',
    category: revisionOrDraft?.category ?? '',
    storedCollateral,
    pinnedContractId: resolved.pinnedContractId,
    contractDisplay: resolved.contractId || storedCollateral,
    status: resolved.status,
    isAvailable: resolved.available,
    isLegacy: resolved.legacy,
    isFixture: resolved.fixture,
    isNative: resolved.isNative,
    code: resolved.code,
    issuer: resolved.issuer,
    issuerShort: resolved.issuerShort,
    sep11: resolved.sep11,
    decimals: resolved.decimals,
    network: resolved.network,
    networkLabel: resolved.networkLabel,
    assetDisplay: resolved.available
      ? (resolved.isNative ? 'XLM' : `${resolved.code} · ${resolved.issuer}`)
      : resolved.summaryLabel,
    shortAssetDisplay: resolved.available
      ? (resolved.isNative ? 'XLM' : `${resolved.code} (${resolved.issuerShort})`)
      : resolved.displayLabel,
    warning: !resolved.available ? resolved.reason : (resolved.legacy ? resolved.note : null),
  });
}

export function resolveModalCollateralConfig({
  fixtureMode,
  collateralAllowlist,
  initialDraft = null,
  search = typeof window !== 'undefined' ? window.location.search : '',
} = {}) {
  const params = new URLSearchParams(search || '');
  const fixtureParam = (params.get('fixture') || '').trim().toLowerCase();
  const envFixture = typeof import.meta !== 'undefined' && import.meta.env?.VITE_COLLATERAL_FIXTURES === 'true';

  const isFixtureMode = typeof fixtureMode === 'boolean'
    ? fixtureMode
    : Boolean(
        envFixture ||
        ['1', 'true', 'collateral', 'duplicate-code', 'wrong-network'].includes(fixtureParam)
      );

  let effectiveInitialDraft = initialDraft;
  if (!effectiveInitialDraft) {
    if (fixtureParam === 'duplicate-code') {
      effectiveInitialDraft = {
        id: 101,
        revisionId: 101,
        revisionNumber: 1,
        question: 'Will Soroban Testnet protocol fees remain unchanged through next quarter?',
        category: 'Crypto',
        collateral: DUPLICATE_CODE_FIXTURES[1].contractId,
      };
    } else if (fixtureParam === 'wrong-network') {
      effectiveInitialDraft = {
        id: 102,
        revisionId: 102,
        revisionNumber: 1,
        question: 'Will Soroban Testnet protocol fees remain unchanged through next quarter?',
        category: 'Crypto',
        collateral: WRONG_NETWORK_FIXTURES.mainnetRevtestA.contractId,
      };
    } else if (fixtureParam === 'legacy-native') {
      effectiveInitialDraft = {...LEGACY_NATIVE_FIXTURE};
    } else if (fixtureParam === 'removed') {
      effectiveInitialDraft = {
        id: 103,
        revisionId: 103,
        revisionNumber: 1,
        question: 'Will Soroban Testnet protocol fees remain unchanged through next quarter?',
        category: 'Crypto',
        collateral: DUPLICATE_CODE_FIXTURES[1].contractId,
      };
    }
  }

  const catalog = getCollateralCatalog({
    fixtureMode: isFixtureMode,
    allowlist: collateralAllowlist,
  });

  const initialCollateral = effectiveInitialDraft?.collateral !== undefined
    ? String(effectiveInitialDraft.collateral)
    : (catalog[0]?.contractId || NATIVE_XLM_SAC);

  return {
    fixtureMode: isFixtureMode,
    fixtureParam,
    catalog,
    initialDraft: effectiveInitialDraft,
    initialCollateral,
  };
}

export async function api(path, {method = 'GET', body, signal} = {}) {
  const response = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    signal: signal || AbortSignal.timeout(5000),
    headers: body ? {'Content-Type': 'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error('Activity service unavailable');
  }
  if (!response.ok) {
    const error = new Error(value.error || 'Activity service error');
    error.status = response.status;
    throw error;
  }
  return value;
}

export async function signInActivity(address, isCurrent = () => true) {
  const [freighter, {checkWallet}] = await Promise.all([
    import('@stellar/freighter-api'),
    import('./wallet.mjs'),
  ]);
  const signMessage = freighter.signMessage || freighter.default?.signMessage;
  await checkWallet(address);
  const challenge = await api('/auth/challenge', {method: 'POST', body: {wallet: address}});
  const prefix = `RevMarket sign-in\nOrigin: ${window.location.origin}\nNetwork: Stellar Testnet\nWallet: ${address}\n`;
  if (challenge.origin !== window.location.origin || challenge.wallet !== address || typeof challenge.message !== 'string' || !challenge.message.startsWith(prefix) || challenge.expiresAt <= Date.now() / 1000 || challenge.expiresAt > Date.now() / 1000 + 180) {
    throw new Error('Invalid activity sign-in challenge');
  }
  const signed = await signMessage(challenge.message, {address});
  if (signed.error || !signed.signedMessage || signed.signerAddress !== address) {
    throw new Error('Activity sign-in signature declined or signer changed');
  }
  await checkWallet(address);
  if (!isCurrent()) throw new Error('Wallet selection changed; sign in again');
  const signature = typeof signed.signedMessage === 'string'
    ? signed.signedMessage
    : btoa(String.fromCharCode(...signed.signedMessage));
  const result = await api('/auth/verify', {method: 'POST', body: {id: challenge.id, signature}});
  if (!isCurrent()) {
    await logoutActivity().catch(() => {});
    throw new Error('Wallet selection changed; sign in again');
  }
  return result;
}

export async function uploadMarketImage(file, wallet, isCurrent = () => true) {
  if (!file || file.size <= 0 || file.size > 5 * 1024 * 1024) throw new Error('Choose an image smaller than 5 MB.');
  const {checkWallet} = await import('./wallet.mjs');
  await checkWallet(wallet);
  let profile = null;
  try {profile = await api('/me');} catch (error) {if (error.status !== 401) throw error;}
  if (profile?.wallet !== wallet) await signInActivity(wallet, isCurrent);
  await checkWallet(wallet);
  if (!isCurrent()) throw new Error('Wallet selection changed; upload again.');

  const form = new FormData();
  form.append('image', file, file.name);
  const response = await fetch('/api/market-image', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'X-Stellar-Wallet': wallet},
    body: form,
    signal: AbortSignal.timeout(45_000),
  });
  let result;
  try {result = await response.json();} catch {throw new Error('Image upload service returned an invalid response.');}
  if (!response.ok) throw new Error(result.error || 'Market image upload failed.');
  if (typeof result.cid !== 'string' || !/^bafy[a-z2-7]{20,}$/.test(result.cid)) throw new Error('Image upload returned an invalid CID.');
  return result.cid;
}

export const logoutActivity = () => api('/logout', {method: 'POST'});

export async function reportActivity(wallet, action, txHash) {
  try {
    return await api('/activity', {method: 'POST', body: {wallet, action, txHash}});
  } catch (error) {
    if (error.status === 401 || error.status === 403) return null;
    throw error;
  }
}

export async function requestAiAssist(draftId) {
  return await api(`/drafts/${draftId}/ai-assist`, {method: 'POST', body: {}});
}

export async function createDraft(draftData = {}, options = {}) {
  const collateral = draftData.collateral !== undefined
    ? pinCollateralForDraft(draftData.collateral, options)
    : NATIVE_XLM_SAC;
  return await api('/drafts', {method: 'POST', body: {...draftData, collateral}});
}

export async function updateDraft(draftId, draftData = {}, options = {}) {
  const collateral = draftData.collateral !== undefined
    ? pinCollateralForDraft(draftData.collateral, options)
    : NATIVE_XLM_SAC;
  return await api(`/drafts/${draftId}`, {method: 'PUT', body: {...draftData, collateral}});
}

export async function getDraft(draftId) {
  return await api(`/drafts/${draftId}`);
}
