import {DatabaseSync} from 'node:sqlite';

export function openStore(filename) {
  const db=new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>4){db.close();throw new Error('Database schema is newer than this backend');}
  if(version===0) db.exec(`
    BEGIN;
    CREATE TABLE users(wallet TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_login INTEGER NOT NULL);
    CREATE TABLE challenges(id TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, wallet TEXT NOT NULL REFERENCES users(wallet) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
    CREATE TABLE activity(id INTEGER PRIMARY KEY, wallet TEXT NOT NULL REFERENCES users(wallet) ON DELETE CASCADE, action TEXT NOT NULL, tx_hash TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(wallet,action,tx_hash));
    CREATE INDEX sessions_expiry ON sessions(expires_at);
    CREATE INDEX activity_wallet ON activity(wallet,id DESC);
    PRAGMA user_version=1;
    COMMIT;
  `);
  if(db.prepare('PRAGMA user_version').get().user_version===1) db.exec(`
    BEGIN;
    CREATE TABLE reviewers(
      wallet TEXT PRIMARY KEY,
      added_by TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE TABLE drafts(
      id INTEGER PRIMARY KEY,
      owner_wallet TEXT NOT NULL,
      origin TEXT NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','ai_assisted')),
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','changes_requested','rejected','approved','confirmed','deployed')),
      current_revision_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX drafts_owner ON drafts(owner_wallet, id DESC);
    CREATE INDEX drafts_status ON drafts(status);
    CREATE TABLE draft_revisions(
      id INTEGER PRIMARY KEY,
      draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      revision_number INTEGER NOT NULL,
      question TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      trading_close INTEGER NOT NULL,
      observation_time INTEGER,
      resolution_deadline INTEGER,
      yes_rule TEXT NOT NULL DEFAULT '',
      no_rule TEXT NOT NULL DEFAULT '',
      equality_rule TEXT NOT NULL DEFAULT '',
      sources_json TEXT NOT NULL DEFAULT '[]',
      fallback_rule TEXT NOT NULL DEFAULT '',
      unavailable_data_rule TEXT NOT NULL DEFAULT '',
      collateral TEXT NOT NULL DEFAULT 'native',
      fee_bps INTEGER NOT NULL DEFAULT 0,
      resolver TEXT NOT NULL DEFAULT '',
      policy_version TEXT NOT NULL DEFAULT '',
      implementation_version TEXT NOT NULL DEFAULT '',
      content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(draft_id, revision_number)
    );
    CREATE TABLE review_decisions(
      id INTEGER PRIMARY KEY,
      draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      revision_id INTEGER NOT NULL REFERENCES draft_revisions(id) ON DELETE CASCADE,
      reviewer_wallet TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('changes_requested','rejected','approved')),
      reason TEXT NOT NULL DEFAULT '',
      approved_params_hash TEXT,
      expiry INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX review_decisions_draft ON review_decisions(draft_id, id DESC);
    CREATE TABLE audit_events(
      id INTEGER PRIMARY KEY,
      draft_id INTEGER REFERENCES drafts(id) ON DELETE CASCADE,
      actor_wallet TEXT NOT NULL,
      action TEXT NOT NULL,
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX audit_events_draft ON audit_events(draft_id, id DESC);
    PRAGMA user_version=2;
    COMMIT;
  `);
  if(db.prepare('PRAGMA user_version').get().user_version===2) db.exec(`
    BEGIN;
    CREATE TABLE market_events(
      id INTEGER PRIMARY KEY,
      network_passphrase TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      ledger INTEGER NOT NULL,
      ledger_closed_at TEXT NOT NULL,
      market_id INTEGER NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('create','prediction','settlement','claim')),
      raw_topic TEXT NOT NULL CHECK(raw_topic IN ('created','predict','settled','claimed')),
      actor_wallet TEXT,
      side INTEGER CHECK(side IS NULL OR side IN (0,1)),
      outcome INTEGER CHECK(outcome IS NULL OR outcome IN (0,1)),
      confidence INTEGER CHECK(confidence IS NULL OR (confidence>=8000 AND confidence<=10000)),
      closes_at TEXT,
      amount TEXT,
      payload_json TEXT NOT NULL,
      indexed_at INTEGER NOT NULL,
      UNIQUE(network_passphrase, contract_id, event_id)
    );
    CREATE INDEX market_events_contract_ledger ON market_events(network_passphrase, contract_id, ledger ASC, id ASC);
    CREATE INDEX market_events_actor ON market_events(actor_wallet, ledger DESC, id DESC) WHERE actor_wallet IS NOT NULL;
    CREATE INDEX market_events_market ON market_events(contract_id, market_id, ledger ASC, id ASC);
    CREATE TABLE ingestion_checkpoints(
      network_passphrase TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      cursor TEXT,
      last_ledger INTEGER,
      oldest_rpc_ledger INTEGER,
      latest_rpc_ledger INTEGER,
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle','complete','gap','unavailable')),
      has_gaps INTEGER NOT NULL DEFAULT 0 CHECK(has_gaps IN (0,1)),
      gap_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(network_passphrase, contract_id)
    );
    CREATE TABLE ingestion_gaps(
      id INTEGER PRIMARY KEY,
      network_passphrase TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK(reason IN ('cursor_expired','start_ledger_pruned','rpc_unavailable')),
      prior_cursor TEXT,
      from_ledger INTEGER,
      to_ledger INTEGER,
      oldest_rpc_ledger INTEGER,
      latest_rpc_ledger INTEGER,
      detail TEXT NOT NULL,
      detected_at INTEGER NOT NULL
    );
    CREATE INDEX ingestion_gaps_scope ON ingestion_gaps(network_passphrase, contract_id, id DESC);
    PRAGMA user_version=3;
    COMMIT;
  `);
  if(db.prepare('PRAGMA user_version').get().user_version===3) db.exec(`
    BEGIN;
    CREATE TABLE publication_intents(
      id INTEGER PRIMARY KEY,
      draft_id INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      revision_id INTEGER NOT NULL REFERENCES draft_revisions(id) ON DELETE CASCADE,
      review_decision_id INTEGER NOT NULL REFERENCES review_decisions(id) ON DELETE CASCADE,
      creator_wallet TEXT NOT NULL,
      reviewer_wallet TEXT NOT NULL,
      target_network TEXT NOT NULL,
      network_passphrase TEXT NOT NULL,
      rules_digest TEXT NOT NULL,
      params_hash TEXT NOT NULL,
      params_json TEXT NOT NULL,
      approval_expiry INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','invalidated','expired')),
      invalidated_reason TEXT,
      invalidated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX publication_intents_active_revision ON publication_intents(revision_id) WHERE status='pending';
    CREATE INDEX publication_intents_draft ON publication_intents(draft_id, id DESC);
    PRAGMA user_version=4;
    COMMIT;
  `);
  return db;
}
