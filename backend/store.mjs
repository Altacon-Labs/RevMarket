import {DatabaseSync} from 'node:sqlite';

export function openStore(filename) {
  const db=new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;');
  const version=db.prepare('PRAGMA user_version').get().user_version;
  if(version>1){db.close();throw new Error('Database schema is newer than this backend');}
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
  return db;
}
