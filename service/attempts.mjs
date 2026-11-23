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
  db.exec(`CREATE TABLE IF NOT EXISTS settlement_jobs (
    network TEXT NOT NULL, contract TEXT NOT NULL, market INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL, window_end INTEGER, failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, state TEXT NOT NULL DEFAULT 'scheduled',
    PRIMARY KEY(network, contract, market)
  )`);
  const retryDelay = failures => Math.min(300, 5 * (2 ** Math.max(0, failures - 1)));
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
    ensureJob(network, contract, market, now = Math.floor(Date.now()/1000)) {
      db.prepare(`INSERT INTO settlement_jobs(network,contract,market,next_attempt_at)
        VALUES(?,?,?,?) ON CONFLICT(network,contract,market) DO NOTHING`).run(network, contract, market, now);
    },
    dueJobs(network, contract, now = Math.floor(Date.now()/1000), limit = 25) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Job batch limit must be 1–100');
      db.prepare(`UPDATE settlement_jobs SET state='expired'
        WHERE network=? AND contract=? AND window_end IS NOT NULL AND window_end < ?`).run(network, contract, now);
      return db.prepare(`SELECT * FROM settlement_jobs WHERE network=? AND contract=?
        AND state='scheduled' AND next_attempt_at <= ? AND (window_end IS NULL OR window_end >= ?)
        ORDER BY next_attempt_at, market LIMIT ?`).all(network, contract, now, now, limit);
    },
    setWindow(network, contract, market, {closesAt, deadline, now = Math.floor(Date.now()/1000)}) {
      const next = now < closesAt ? closesAt : now;
      db.prepare(`UPDATE settlement_jobs SET window_end=?, next_attempt_at=?,
        state=CASE WHEN ? > ? THEN 'expired' ELSE state END
        WHERE network=? AND contract=? AND market=?`).run(deadline, next, now, deadline, network, contract, market);
    },
    defer(network, contract, market, {now = Math.floor(Date.now()/1000), error, maxFailures = 8} = {}) {
      const job = db.prepare('SELECT failures,window_end FROM settlement_jobs WHERE network=? AND contract=? AND market=?').get(network, contract, market);
      if (!job) return null;
      const failures = job.failures + 1;
      if (failures >= maxFailures || (job.window_end !== null && now + retryDelay(failures) > job.window_end)) {
        db.prepare(`UPDATE settlement_jobs SET failures=?,state='expired',last_error=? WHERE network=? AND contract=? AND market=?`)
          .run(failures, String(error || 'retry limit reached').slice(0, 500), network, contract, market);
        return null;
      }
      const next = now + retryDelay(failures);
      db.prepare(`UPDATE settlement_jobs SET failures=?,next_attempt_at=?,last_error=? WHERE network=? AND contract=? AND market=?`)
        .run(failures, next, String(error || '').slice(0, 500), network, contract, market);
      return next;
    },
    completeJob(network, contract, market, state = 'complete') {
      db.prepare('UPDATE settlement_jobs SET state=? WHERE network=? AND contract=? AND market=?').run(state, network, contract, market);
    },
    getJob(network, contract, market) {
      return db.prepare('SELECT * FROM settlement_jobs WHERE network=? AND contract=? AND market=?').get(network, contract, market);
    },
    close() { db.close(); },
  };
}

export { terminal as terminalAttemptStatuses };
