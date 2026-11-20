import { Networks, StrKey, rpc, scValToNative, xdr } from '@stellar/stellar-sdk';

export const EVENT_TYPE_BY_TOPIC = Object.freeze({
  created: 'create',
  predict: 'prediction',
  settled: 'settlement',
  claimed: 'claim',
});

const MAX_U32 = 0xffffffffn;
const MAX_U64 = 0xffffffffffffffffn;
const MAX_I128 = (1n << 127n) - 1n;

function isStellarAddress(value) {
  return typeof value === 'string' && (StrKey.isValidEd25519PublicKey(value) || StrKey.isValidContract(value));
}

function decodeScVal(input) {
  if (!input) throw new Error('Missing ScVal payload');
  if (typeof input === 'object' && (typeof input.type === 'string' || typeof input.switch === 'function') && typeof input.toXDR === 'function') {
    return input;
  }
  if (typeof input === 'string') return xdr.ScVal.fromXDR(input, 'base64');
  if (typeof input === 'object' && typeof input.xdr === 'string') return xdr.ScVal.fromXDR(input.xdr, 'base64');
  throw new Error('Unsupported ScVal encoding');
}

function scValType(scVal) {
  if (!scVal) return '';
  if (typeof scVal.type === 'string') return scVal.type;
  if (typeof scVal.switch === 'function') return scVal.switch().name;
  return '';
}

function scValVecItems(scVal) {
  if (Array.isArray(scVal?.vec)) return scVal.vec;
  if (typeof scVal?.vec === 'function') return scVal.vec() || [];
  if (Array.isArray(scVal?.value)) return scVal.value;
  return [];
}

function extractContractId(rawContract) {
  if (typeof rawContract === 'string') return rawContract;
  if (rawContract && typeof rawContract.contractId === 'function') return rawContract.contractId();
  return '';
}

function sanitizeErrorDetail(err) {
  const raw = typeof err?.message === 'string'
    ? err.message
    : (typeof err === 'string' ? err : 'RPC request failed');
  return raw.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240) || 'RPC request failed';
}

function parseLedgerWindowFromError(err) {
  const msg = sanitizeErrorDetail(err);
  const match = msg.match(/ledger range:\s*(\d+)\s*-\s*(\d+)/i);
  if (!match) return null;
  const oldestLedger = Number(match[1]);
  const latestLedger = Number(match[2]);
  if (!Number.isSafeInteger(oldestLedger) || !Number.isSafeInteger(latestLedger)) return null;
  return { oldestLedger, latestLedger };
}

function isRetentionOrCursorError(err) {
  const code = err?.code;
  const msg = sanitizeErrorDetail(err);
  if ( /ledger range:\s*\d+\s*-\s*\d+/i.test(msg) ) return true;
  if ( /cursor.*(?:expired|out of range|before oldest|too old|invalid|not within|pruned)/i.test(msg) ) return true;
  if ( /startLedger.*(?:within|out of range|before oldest|older than|retention)/i.test(msg) ) return true;
  if ((code === -32600 || code === -32602) && /(?:cursor|startLedger|ledger)/i.test(msg)) return true;
  return false;
}

export function normalizeMarketEvent(rawEvent, { contractId, networkPassphrase = Networks.TESTNET } = {}) {
  if (networkPassphrase !== Networks.TESTNET) {
    throw new Error('Indexer supports Stellar Testnet only');
  }
  if (typeof contractId !== 'string' || !StrKey.isValidContract(contractId)) {
    throw new Error('Valid Soroban C-address contractId required');
  }
  if (!rawEvent || typeof rawEvent !== 'object') {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'Event entry must be an object' };
  }
  if (rawEvent.networkPassphrase !== undefined && rawEvent.networkPassphrase !== networkPassphrase) {
    return { status: 'excluded', reason: 'wrong_network', detail: 'Event networkPassphrase mismatch' };
  }
  if (rawEvent.network !== undefined && String(rawEvent.network).toLowerCase() !== 'testnet') {
    return { status: 'excluded', reason: 'wrong_network', detail: 'Event network tag mismatch' };
  }
  if (rawEvent.type !== 'contract') {
    return { status: 'excluded', reason: 'non_contract_event', detail: String(rawEvent.type || 'unknown') };
  }
  if (rawEvent.inSuccessfulContractCall === false) {
    return { status: 'excluded', reason: 'failed_call', detail: 'Unsuccessful contract call event' };
  }

  const eventContractId = extractContractId(rawEvent.contractId);
  if (eventContractId !== contractId) {
    return { status: 'excluded', reason: 'wrong_contract', detail: eventContractId || 'missing_contract_id' };
  }

  const eventId = typeof rawEvent.id === 'string' && rawEvent.id.trim()
    ? rawEvent.id.trim()
    : (typeof rawEvent.pagingToken === 'string' && rawEvent.pagingToken.trim() ? rawEvent.pagingToken.trim() : '');
  if (!eventId || eventId.length > 128) {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'Missing or invalid event ID' };
  }

  const ledger = Number(rawEvent.ledger);
  if (!Number.isSafeInteger(ledger) || ledger <= 0) {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'Invalid event ledger sequence' };
  }

  const txHashRaw = typeof rawEvent.txHash === 'string' ? rawEvent.txHash.trim() : '';
  if (!/^[0-9a-fA-F]{64}$/.test(txHashRaw)) {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'Invalid transaction hash' };
  }
  const txHash = txHashRaw.toLowerCase();

  const ledgerClosedAt = typeof rawEvent.ledgerClosedAt === 'string' && rawEvent.ledgerClosedAt.trim()
    ? rawEvent.ledgerClosedAt.trim()
    : String(rawEvent.ledgerClosedAt ?? '');
  if (!ledgerClosedAt || ledgerClosedAt.length > 64) {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'Missing ledgerClosedAt timestamp' };
  }

  if (!Array.isArray(rawEvent.topic) || rawEvent.topic.length === 0) {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'Missing event topics' };
  }

  let topicSymSc;
  try {
    topicSymSc = decodeScVal(rawEvent.topic[0]);
  } catch {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'Undecodable event topic[0]' };
  }
  if (scValType(topicSymSc) !== 'scvSymbol') {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'topic[0] must be scvSymbol' };
  }

  const rawTopic = String(scValToNative(topicSymSc));
  const eventType = EVENT_TYPE_BY_TOPIC[rawTopic];
  if (!eventType) {
    return { status: 'excluded', reason: 'ignored_topic', detail: rawTopic };
  }

  if (rawEvent.topic.length !== 2) {
    return { status: 'excluded', reason: 'invalid_payload', detail: `Expected 2 topics for ${rawTopic}` };
  }

  let marketIdSc;
  let valueSc;
  try {
    marketIdSc = decodeScVal(rawEvent.topic[1]);
    valueSc = decodeScVal(rawEvent.value);
  } catch {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'Undecodable market ID or value XDR' };
  }

  if (scValType(marketIdSc) !== 'scvU32') {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'topic[1] market ID must be scvU32' };
  }
  const marketIdBig = BigInt(scValToNative(marketIdSc));
  if (marketIdBig < 0n || marketIdBig > MAX_U32) {
    return { status: 'excluded', reason: 'invalid_payload', detail: 'Market ID out of u32 bounds' };
  }
  const marketId = Number(marketIdBig);

  let actorWallet = null;
  let side = null;
  let outcome = null;
  let confidence = null;
  let closesAt = null;
  let amount = null;
  let payload;

  if (rawTopic === 'created') {
    if (scValType(valueSc) !== 'scvU64') {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'created value must be scvU64' };
    }
    const closesBig = BigInt(scValToNative(valueSc));
    if (closesBig <= 0n || closesBig > MAX_U64) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'created closes_at out of u64 bounds' };
    }
    closesAt = closesBig.toString();
    payload = { marketId, closesAt };
  } else if (rawTopic === 'predict') {
    if (scValType(valueSc) !== 'scvVec') {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'predict value must be 3-tuple scvVec' };
    }
    const items = scValVecItems(valueSc);
    if (items.length !== 3) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'predict tuple length must be 3' };
    }
    const [userSc, sideSc, amtSc] = items;
    if (scValType(userSc) !== 'scvAddress' || scValType(sideSc) !== 'scvU32' || scValType(amtSc) !== 'scvI128') {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'predict tuple types must be (Address, u32, i128)' };
    }
    const userAddr = String(scValToNative(userSc));
    if (!isStellarAddress(userAddr)) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'Invalid predictor Stellar address' };
    }
    const sideNum = Number(scValToNative(sideSc));
    if (sideNum !== 0 && sideNum !== 1) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'predict side must be 0 or 1' };
    }
    const amtBig = BigInt(scValToNative(amtSc));
    if (amtBig <= 0n || amtBig > MAX_I128) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'predict amount must be positive i128' };
    }
    actorWallet = userAddr;
    side = sideNum;
    amount = amtBig.toString();
    payload = { marketId, user: actorWallet, side, amount };
  } else if (rawTopic === 'settled') {
    if (scValType(valueSc) !== 'scvVec') {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'settled value must be 2-tuple scvVec' };
    }
    const items = scValVecItems(valueSc);
    if (items.length !== 2) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'settled tuple length must be 2' };
    }
    const [outcomeSc, confSc] = items;
    if (scValType(outcomeSc) !== 'scvU32' || scValType(confSc) !== 'scvU32') {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'settled tuple types must be (u32, u32)' };
    }
    const outcomeNum = Number(scValToNative(outcomeSc));
    const confNum = Number(scValToNative(confSc));
    if ((outcomeNum !== 0 && outcomeNum !== 1) || confNum < 8000 || confNum > 10000) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'settled outcome or confidence out of contract bounds' };
    }
    outcome = outcomeNum;
    confidence = confNum;
    payload = { marketId, outcome, confidence };
  } else if (rawTopic === 'claimed') {
    if (scValType(valueSc) !== 'scvVec') {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'claimed value must be 2-tuple scvVec' };
    }
    const items = scValVecItems(valueSc);
    if (items.length !== 2) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'claimed tuple length must be 2' };
    }
    const [userSc, payoutSc] = items;
    if (scValType(userSc) !== 'scvAddress' || scValType(payoutSc) !== 'scvI128') {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'claimed tuple types must be (Address, i128)' };
    }
    const userAddr = String(scValToNative(userSc));
    if (!isStellarAddress(userAddr)) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'Invalid claimant Stellar address' };
    }
    const payoutBig = BigInt(scValToNative(payoutSc));
    if (payoutBig <= 0n || payoutBig > MAX_I128) {
      return { status: 'excluded', reason: 'invalid_payload', detail: 'claimed payout must be positive i128' };
    }
    actorWallet = userAddr;
    amount = payoutBig.toString();
    payload = { marketId, user: actorWallet, payout: amount };
  }

  return {
    status: 'normalized',
    record: {
      networkPassphrase,
      contractId,
      eventId,
      txHash,
      ledger,
      ledgerClosedAt,
      marketId,
      eventType,
      rawTopic,
      actorWallet,
      side,
      outcome,
      confidence,
      closesAt,
      amount,
      payload,
    },
  };
}

export function createMarketEventIngestor({
  db,
  contractId,
  rpcUrl = 'https://soroban-testnet.stellar.org',
  rpcClient = null,
  networkPassphrase = Networks.TESTNET,
  startLedger = undefined,
  pageLimit = 100,
  maxPages = 50,
  now = () => Math.floor(Date.now() / 1000),
  onBeforeCheckpointCommit = null,
} = {}) {
  if (!db || typeof db.prepare !== 'function' || typeof db.exec !== 'function') {
    throw new Error('SQLite DatabaseSync instance required');
  }
  if (networkPassphrase !== Networks.TESTNET) {
    throw new Error('Indexer supports Stellar Testnet only');
  }
  if (typeof contractId !== 'string' || !StrKey.isValidContract(contractId)) {
    throw new Error('Valid Soroban C-address contractId required');
  }
  if (!Number.isSafeInteger(pageLimit) || pageLimit < 1 || pageLimit > 200) {
    throw new Error('pageLimit must be an integer between 1 and 200');
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 1000) {
    throw new Error('maxPages must be an integer between 1 and 1000');
  }
  if (startLedger !== undefined && (!Number.isSafeInteger(startLedger) || startLedger < 1)) {
    throw new Error('startLedger must be a positive integer');
  }
  if (!rpcClient && (typeof rpcUrl !== 'string' || !rpcUrl.startsWith('https://'))) {
    throw new Error('HTTPS RPC URL required');
  }

  const transport = rpcClient || new rpc.Server(rpcUrl);

  const selectCheckpointStmt = db.prepare(`
    SELECT
      network_passphrase AS networkPassphrase,
      contract_id AS contractId,
      cursor,
      last_ledger AS lastLedger,
      oldest_rpc_ledger AS oldestRpcLedger,
      latest_rpc_ledger AS latestRpcLedger,
      status,
      has_gaps AS hasGaps,
      gap_count AS gapCount,
      last_error AS lastError,
      updated_at AS updatedAt
    FROM ingestion_checkpoints
    WHERE network_passphrase = ? AND contract_id = ?
  `);

  const countGapsStmt = db.prepare(`
    SELECT COUNT(*) AS n
    FROM ingestion_gaps
    WHERE network_passphrase = ? AND contract_id = ?
  `);

  const insertEventStmt = db.prepare(`
    INSERT INTO market_events(
      network_passphrase, contract_id, event_id, tx_hash, ledger, ledger_closed_at,
      market_id, event_type, raw_topic, actor_wallet, side, outcome, confidence,
      closes_at, amount, payload_json, indexed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(network_passphrase, contract_id, event_id) DO NOTHING
  `);

  const upsertCheckpointStmt = db.prepare(`
    INSERT INTO ingestion_checkpoints(
      network_passphrase, contract_id, cursor, last_ledger, oldest_rpc_ledger,
      latest_rpc_ledger, status, has_gaps, gap_count, last_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(network_passphrase, contract_id) DO UPDATE SET
      cursor = excluded.cursor,
      last_ledger = excluded.last_ledger,
      oldest_rpc_ledger = excluded.oldest_rpc_ledger,
      latest_rpc_ledger = excluded.latest_rpc_ledger,
      status = excluded.status,
      has_gaps = excluded.has_gaps,
      gap_count = excluded.gap_count,
      last_error = excluded.last_error,
      updated_at = excluded.updated_at
  `);

  const insertGapStmt = db.prepare(`
    INSERT INTO ingestion_gaps(
      network_passphrase, contract_id, reason, prior_cursor, from_ledger, to_ledger,
      oldest_rpc_ledger, latest_rpc_ledger, detail, detected_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function getCheckpoint() {
    const row = selectCheckpointStmt.get(networkPassphrase, contractId);
    if (!row) return null;
    return {
      ...row,
      hasGaps: Boolean(row.hasGaps),
      complete: row.status === 'complete' && !row.hasGaps,
    };
  }

  function getGaps({ limit = 50 } = {}) {
    const bounded = Math.min(200, Math.max(1, Number(limit) || 50));
    return db.prepare(`
      SELECT
        id,
        network_passphrase AS networkPassphrase,
        contract_id AS contractId,
        reason,
        prior_cursor AS priorCursor,
        from_ledger AS fromLedger,
        to_ledger AS toLedger,
        oldest_rpc_ledger AS oldestRpcLedger,
        latest_rpc_ledger AS latestRpcLedger,
        detail,
        detected_at AS detectedAt
      FROM ingestion_gaps
      WHERE network_passphrase = ? AND contract_id = ?
      ORDER BY id DESC
      LIMIT ?
    `).all(networkPassphrase, contractId, bounded);
  }

  function listEvents({ marketId, actorWallet, eventType, limit = 100, afterId = 0 } = {}) {
    const clauses = ['network_passphrase = ?', 'contract_id = ?', 'id > ?'];
    const params = [networkPassphrase, contractId, Number(afterId) || 0];
    if (marketId !== undefined) {
      clauses.push('market_id = ?');
      params.push(Number(marketId));
    }
    if (actorWallet !== undefined) {
      clauses.push('actor_wallet = ?');
      params.push(String(actorWallet));
    }
    if (eventType !== undefined) {
      clauses.push('event_type = ?');
      params.push(String(eventType));
    }
    const bounded = Math.min(500, Math.max(1, Number(limit) || 100));
    params.push(bounded);
    const rows = db.prepare(`
      SELECT
        id,
        event_id AS eventId,
        tx_hash AS txHash,
        ledger,
        ledger_closed_at AS ledgerClosedAt,
        market_id AS marketId,
        event_type AS eventType,
        raw_topic AS rawTopic,
        actor_wallet AS actorWallet,
        side,
        outcome,
        confidence,
        closes_at AS closesAt,
        amount,
        payload_json AS payloadJson,
        indexed_at AS indexedAt
      FROM market_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY ledger ASC, id ASC
      LIMIT ?
    `).all(...params);
    return rows.map(row => ({
      ...row,
      payload: JSON.parse(row.payloadJson),
    }));
  }

  function persistGapAndStatus({
    reason,
    checkpointStatus,
    priorCursor,
    fromLedger,
    toLedger,
    oldestRpcLedger = null,
    latestRpcLedger = null,
    detail,
  }) {
    const ts = now();
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = selectCheckpointStmt.get(networkPassphrase, contractId);
      insertGapStmt.run(
        networkPassphrase,
        contractId,
        reason,
        priorCursor ?? existing?.cursor ?? null,
        fromLedger ?? null,
        toLedger ?? null,
        oldestRpcLedger,
        latestRpcLedger,
        detail,
        ts,
      );
      const totalGaps = countGapsStmt.get(networkPassphrase, contractId).n;
      upsertCheckpointStmt.run(
        networkPassphrase,
        contractId,
        existing?.cursor ?? null,
        existing?.lastLedger ?? null,
        oldestRpcLedger ?? existing?.oldestRpcLedger ?? null,
        latestRpcLedger ?? existing?.latestRpcLedger ?? null,
        checkpointStatus,
        1,
        totalGaps,
        detail,
        ts,
      );
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return getGaps({ limit: 1 })[0];
  }

  async function resolveAutoStartLedger() {
    if (typeof transport.getLatestLedger !== 'function') return 1;
    const latest = await transport.getLatestLedger();
    const seq = Number(latest?.sequence);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new Error('Invalid getLatestLedger sequence from RPC');
    }
    const probe = await transport.getEvents({
      startLedger: seq,
      filters: [{ type: 'contract', contractIds: [contractId] }],
      limit: 1,
    });
    const oldest = Number(probe?.oldestLedger);
    return Number.isSafeInteger(oldest) && oldest >= 1 && oldest <= seq ? oldest : seq;
  }

  async function sync({ recoveryStartLedger = undefined, maxPages: runMaxPages = maxPages } = {}) {
    if (recoveryStartLedger !== undefined && (!Number.isSafeInteger(recoveryStartLedger) || recoveryStartLedger < 1)) {
      throw new Error('recoveryStartLedger must be a positive integer');
    }
    if (!Number.isSafeInteger(runMaxPages) || runMaxPages < 1 || runMaxPages > 1000) {
      throw new Error('maxPages must be an integer between 1 and 1000');
    }

    let netInfo;
    try {
      netInfo = await transport.getNetwork();
    } catch (err) {
      const detail = sanitizeErrorDetail(err);
      const gap = persistGapAndStatus({
        reason: 'rpc_unavailable',
        checkpointStatus: 'unavailable',
        priorCursor: getCheckpoint()?.cursor ?? null,
        fromLedger: getCheckpoint()?.lastLedger ? getCheckpoint().lastLedger + 1 : (startLedger ?? null),
        toLedger: null,
        detail,
      });
      return {
        status: 'unavailable',
        complete: false,
        reason: 'rpc_unavailable',
        insertedCount: 0,
        duplicateCount: 0,
        excludedCount: 0,
        ignoredTopicCount: 0,
        pagesProcessed: 0,
        checkpoint: getCheckpoint(),
        gap,
      };
    }

    if (!netInfo || netInfo.passphrase !== networkPassphrase) {
      throw new Error(`RPC network passphrase mismatch: expected Stellar Testnet, got ${String(netInfo?.passphrase || 'unknown')}`);
    }

    let cp = getCheckpoint();
    let currentCursor = cp?.cursor || null;
    let currentLastLedger = cp?.lastLedger ?? null;
    let nextStartLedger = startLedger;

    if (recoveryStartLedger !== undefined) {
      if (currentLastLedger !== null && recoveryStartLedger > currentLastLedger + 1) {
        persistGapAndStatus({
          reason: 'cursor_expired',
          checkpointStatus: 'gap',
          priorCursor: currentCursor,
          fromLedger: currentLastLedger + 1,
          toLedger: recoveryStartLedger - 1,
          detail: `Explicit recovery jump from ledger ${currentLastLedger} to ${recoveryStartLedger}`,
        });
        cp = getCheckpoint();
      }
      currentCursor = null;
      nextStartLedger = recoveryStartLedger;
    } else if (!currentCursor && nextStartLedger === undefined) {
      try {
        nextStartLedger = await resolveAutoStartLedger();
      } catch (err) {
        const detail = sanitizeErrorDetail(err);
        const gap = persistGapAndStatus({
          reason: 'rpc_unavailable',
          checkpointStatus: 'unavailable',
          priorCursor: null,
          fromLedger: null,
          toLedger: null,
          detail,
        });
        return {
          status: 'unavailable',
          complete: false,
          reason: 'rpc_unavailable',
          insertedCount: 0,
          duplicateCount: 0,
          excludedCount: 0,
          ignoredTopicCount: 0,
          pagesProcessed: 0,
          checkpoint: getCheckpoint(),
          gap,
        };
      }
    }

    const filters = [{ type: 'contract', contractIds: [contractId] }];
    let insertedCount = 0;
    let duplicateCount = 0;
    let excludedCount = 0;
    let ignoredTopicCount = 0;
    let pagesProcessed = 0;
    let caughtUpToTip = false;

    for (let page = 0; page < runMaxPages; page++) {
      const req = currentCursor
        ? { cursor: currentCursor, filters, limit: pageLimit }
        : { startLedger: nextStartLedger, filters, limit: pageLimit };

      let resp;
      try {
        resp = await transport.getEvents(req);
      } catch (err) {
        const detail = sanitizeErrorDetail(err);
        const windowBounds = parseLedgerWindowFromError(err);
        if (isRetentionOrCursorError(err)) {
          const reason = currentCursor ? 'cursor_expired' : 'start_ledger_pruned';
          const fromLedger = currentCursor
            ? (currentLastLedger !== null ? currentLastLedger + 1 : null)
            : nextStartLedger;
          const toLedger = windowBounds?.oldestLedger ? windowBounds.oldestLedger - 1 : null;
          const gap = persistGapAndStatus({
            reason,
            checkpointStatus: 'gap',
            priorCursor: currentCursor,
            fromLedger,
            toLedger,
            oldestRpcLedger: windowBounds?.oldestLedger ?? null,
            latestRpcLedger: windowBounds?.latestLedger ?? null,
            detail,
          });
          return {
            status: 'gap',
            complete: false,
            reason,
            insertedCount,
            duplicateCount,
            excludedCount,
            ignoredTopicCount,
            pagesProcessed,
            checkpoint: getCheckpoint(),
            gap,
          };
        }

        const gap = persistGapAndStatus({
          reason: 'rpc_unavailable',
          checkpointStatus: 'unavailable',
          priorCursor: currentCursor,
          fromLedger: currentLastLedger !== null ? currentLastLedger + 1 : (nextStartLedger ?? null),
          toLedger: null,
          oldestRpcLedger: windowBounds?.oldestLedger ?? null,
          latestRpcLedger: windowBounds?.latestLedger ?? null,
          detail,
        });
        return {
          status: 'unavailable',
          complete: false,
          reason: 'rpc_unavailable',
          insertedCount,
          duplicateCount,
          excludedCount,
          ignoredTopicCount,
          pagesProcessed,
          checkpoint: getCheckpoint(),
          gap,
        };
      }

      if (!resp || !Array.isArray(resp.events)) {
        const gap = persistGapAndStatus({
          reason: 'rpc_unavailable',
          checkpointStatus: 'unavailable',
          priorCursor: currentCursor,
          fromLedger: currentLastLedger !== null ? currentLastLedger + 1 : (nextStartLedger ?? null),
          toLedger: null,
          detail: 'Malformed getEvents response from RPC',
        });
        return {
          status: 'unavailable',
          complete: false,
          reason: 'rpc_unavailable',
          insertedCount,
          duplicateCount,
          excludedCount,
          ignoredTopicCount,
          pagesProcessed,
          checkpoint: getCheckpoint(),
          gap,
        };
      }

      const oldestRpcLedger = Number.isSafeInteger(Number(resp.oldestLedger)) ? Number(resp.oldestLedger) : null;
      const latestRpcLedger = Number.isSafeInteger(Number(resp.latestLedger)) ? Number(resp.latestLedger) : null;

      if (currentCursor && oldestRpcLedger !== null && currentLastLedger !== null && oldestRpcLedger > currentLastLedger + 1) {
        const gap = persistGapAndStatus({
          reason: 'cursor_expired',
          checkpointStatus: 'gap',
          priorCursor: currentCursor,
          fromLedger: currentLastLedger + 1,
          toLedger: oldestRpcLedger - 1,
          oldestRpcLedger,
          latestRpcLedger,
          detail: `RPC retention oldestLedger ${oldestRpcLedger} advanced past checkpoint ledger ${currentLastLedger}`,
        });
        return {
          status: 'gap',
          complete: false,
          reason: 'cursor_expired',
          insertedCount,
          duplicateCount,
          excludedCount,
          ignoredTopicCount,
          pagesProcessed,
          checkpoint: getCheckpoint(),
          gap,
        };
      }

      if (!currentCursor && nextStartLedger !== undefined && oldestRpcLedger !== null && oldestRpcLedger > nextStartLedger) {
        const gap = persistGapAndStatus({
          reason: 'start_ledger_pruned',
          checkpointStatus: 'gap',
          priorCursor: null,
          fromLedger: nextStartLedger,
          toLedger: oldestRpcLedger - 1,
          oldestRpcLedger,
          latestRpcLedger,
          detail: `Requested startLedger ${nextStartLedger} is older than RPC oldestLedger ${oldestRpcLedger}`,
        });
        return {
          status: 'gap',
          complete: false,
          reason: 'start_ledger_pruned',
          insertedCount,
          duplicateCount,
          excludedCount,
          ignoredTopicCount,
          pagesProcessed,
          checkpoint: getCheckpoint(),
          gap,
        };
      }

      const normalizedBatch = [];
      let pageExcluded = 0;
      let pageIgnored = 0;
      let maxEventLedger = currentLastLedger;

      for (const rawEv of resp.events) {
        const res = normalizeMarketEvent(rawEv, { contractId, networkPassphrase });
        if (res.status === 'normalized') {
          normalizedBatch.push(res.record);
          if (maxEventLedger === null || res.record.ledger > maxEventLedger) {
            maxEventLedger = res.record.ledger;
          }
        } else if (res.reason === 'ignored_topic') {
          pageIgnored++;
          const evContract = extractContractId(rawEv?.contractId);
          const evLedger = Number(rawEv?.ledger);
          if (evContract === contractId && Number.isSafeInteger(evLedger) && evLedger > 0) {
            if (maxEventLedger === null || evLedger > maxEventLedger) maxEventLedger = evLedger;
          }
        } else {
          pageExcluded++;
        }
      }

      const lastRawEvent = resp.events.length > 0 ? resp.events[resp.events.length - 1] : null;
      const fallbackEventCursor = lastRawEvent
        ? (typeof lastRawEvent.id === 'string' && lastRawEvent.id.trim()
          ? lastRawEvent.id.trim()
          : (typeof lastRawEvent.pagingToken === 'string' ? lastRawEvent.pagingToken.trim() : ''))
        : '';
      const nextCursor = typeof resp.cursor === 'string' && resp.cursor.trim()
        ? resp.cursor.trim()
        : (fallbackEventCursor || currentCursor);

      if (!nextCursor) {
        const gap = persistGapAndStatus({
          reason: 'rpc_unavailable',
          checkpointStatus: 'unavailable',
          priorCursor: currentCursor,
          fromLedger: currentLastLedger !== null ? currentLastLedger + 1 : (nextStartLedger ?? null),
          toLedger: null,
          oldestRpcLedger,
          latestRpcLedger,
          detail: 'RPC getEvents response omitted cursor',
        });
        return {
          status: 'unavailable',
          complete: false,
          reason: 'rpc_unavailable',
          insertedCount,
          duplicateCount,
          excludedCount,
          ignoredTopicCount,
          pagesProcessed,
          checkpoint: getCheckpoint(),
          gap,
        };
      }

      const newLastLedger = resp.events.length === 0 && latestRpcLedger !== null
        ? (maxEventLedger === null ? latestRpcLedger : Math.max(maxEventLedger, latestRpcLedger))
        : maxEventLedger;

      const ts = now();
      let pageInserted = 0;
      let pageDuplicates = 0;

      db.exec('BEGIN IMMEDIATE');
      try {
        for (const rec of normalizedBatch) {
          const info = insertEventStmt.run(
            rec.networkPassphrase,
            rec.contractId,
            rec.eventId,
            rec.txHash,
            rec.ledger,
            rec.ledgerClosedAt,
            rec.marketId,
            rec.eventType,
            rec.rawTopic,
            rec.actorWallet,
            rec.side,
            rec.outcome,
            rec.confidence,
            rec.closesAt,
            rec.amount,
            JSON.stringify(rec.payload),
            ts,
          );
          if (info.changes > 0) pageInserted++;
          else pageDuplicates++;
        }

        if (typeof onBeforeCheckpointCommit === 'function') {
          onBeforeCheckpointCommit({
            page: pagesProcessed + 1,
            pageInserted,
            pageDuplicates,
            nextCursor,
          });
        }

        const totalGaps = countGapsStmt.get(networkPassphrase, contractId).n;
        const hasGaps = totalGaps > 0 ? 1 : 0;
        const cpStatus = hasGaps ? 'gap' : 'complete';

        upsertCheckpointStmt.run(
          networkPassphrase,
          contractId,
          nextCursor,
          newLastLedger,
          oldestRpcLedger,
          latestRpcLedger,
          cpStatus,
          hasGaps,
          totalGaps,
          hasGaps ? (cp?.lastError ?? 'Prior retention or RPC gap recorded') : null,
          ts,
        );
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }

      insertedCount += pageInserted;
      duplicateCount += pageDuplicates;
      excludedCount += pageExcluded;
      ignoredTopicCount += pageIgnored;
      pagesProcessed++;

      const reachedEnd = resp.events.length === 0 || nextCursor === currentCursor;
      currentCursor = nextCursor;
      currentLastLedger = newLastLedger;
      cp = getCheckpoint();

      if (reachedEnd) {
        caughtUpToTip = true;
        break;
      }
    }

    const finalCheckpoint = getCheckpoint();
    const hasGaps = Boolean(finalCheckpoint?.hasGaps);
    const complete = !hasGaps && caughtUpToTip;

    return {
      status: hasGaps ? 'gap' : 'ok',
      complete,
      caughtUpToTip,
      insertedCount,
      duplicateCount,
      excludedCount,
      ignoredTopicCount,
      pagesProcessed,
      checkpoint: finalCheckpoint,
      gap: hasGaps ? (getGaps({ limit: 1 })[0] ?? null) : null,
    };
  }

  return {
    sync,
    getCheckpoint,
    getGaps,
    listEvents,
  };
}
