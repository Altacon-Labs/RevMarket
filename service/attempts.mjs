import { DatabaseSync } from 'node:sqlite';

const terminal = new Set(['confirmed', 'failed', 'expired']);

export function createAttemptStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS settlement_attempts (
    network TEXT NOT NULL, contract TEXT NOT NULL, market INTEGER NOT NULL,
    hash TEXT NOT NULL, signed_xdr TEXT NOT NULL, evidence_hash TEXT NOT NULL,
    sequence TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(network, contract, market)
  )`);
  return {
    get(network, contract, market) {
      return db.prepare('SELECT * FROM settlement_attempts WHERE network=? AND contract=? AND market=?').get(network, contract, market);
    },
    begin(attempt) {
      db.prepare(`INSERT INTO settlement_attempts VALUES(?,?,?,?,?,?,?,'prepared',?)
        ON CONFLICT(network,contract,market) DO NOTHING`).run(
        attempt.network, attempt.contract, attempt.market, attempt.hash, attempt.signedXdr,
        attempt.evidenceHash, attempt.sequence, Math.floor(Date.now()/1000));
      const existing = this.get(attempt.network, attempt.contract, attempt.market);
      if (existing.hash !== attempt.hash) return {created:false, attempt:existing};
      return {created:true, attempt:existing};
    },
    update(network, contract, market, status) {
      db.prepare('UPDATE settlement_attempts SET status=? WHERE network=? AND contract=? AND market=?')
        .run(status, network, contract, market);
    },
    close() { db.close(); },
  };
}

export { terminal as terminalAttemptStatuses };
