// Synthetic populated v2 data for backup tests and the restore drill. Never used against backend/data.
// Wallets are synthetic placeholders, not real accounts; questions are generic fixture text.
import {createHash} from 'node:crypto';

export function syntheticWallet(i){
  return ('GFIXTURE'+String(i).padStart(10,'0')).padEnd(56,'A');
}

const contentHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const statuses=['draft','submitted','changes_requested','rejected','approved'];

export function insertRevision(db,{draftId,number,time}){
  const question=`Fixture question ${draftId}.${number}`;
  const id=Number(db.prepare(`INSERT INTO draft_revisions(draft_id,revision_number,question,category,trading_close,yes_rule,no_rule,sources_json,content_hash,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(draftId,number,question,'fixture',time+86400,'YES if fixture rule holds','NO otherwise','["fixture"]',contentHash({draftId,number,question}),time).lastInsertRowid);
  db.prepare('UPDATE drafts SET current_revision_id=?,updated_at=? WHERE id=?').run(id,time,draftId);
  return id;
}

/** One draft with 1-3 revisions, plus a review decision and audit event for some drafts. Caller owns the transaction. */
export function insertDraft(db,{index,owner,reviewer,time}){
  const draftId=Number(db.prepare('INSERT INTO drafts(owner_wallet,origin,status,created_at,updated_at) VALUES(?,?,?,?,?)')
    .run(owner,index%5===0?'ai_assisted':'manual',statuses[index%statuses.length],time,time).lastInsertRowid);
  let revisionId;
  const revisions=1+(index%3);
  for(let n=1;n<=revisions;n++)revisionId=insertRevision(db,{draftId,number:n,time:time+n});
  if(index%2===0){
    db.prepare('INSERT INTO review_decisions(draft_id,revision_id,reviewer_wallet,decision,reason,created_at) VALUES(?,?,?,?,?,?)')
      .run(draftId,revisionId,reviewer,index%4===0?'approved':'changes_requested','fixture review',time+10);
  }
  db.prepare('INSERT INTO audit_events(draft_id,actor_wallet,action,detail_json,created_at) VALUES(?,?,?,?,?)')
    .run(draftId,owner,'created',JSON.stringify({revisionId}),time);
  return draftId;
}

/** Seed a database opened with openStore() (schema v2 or later). */
export function seedFixture(db,{drafts=100,users=Math.max(5,Math.ceil(drafts/10)),reviewers=3,time=1_800_000_000}={}){
  db.exec('BEGIN IMMEDIATE');
  try{
    for(let u=0;u<users;u++){
      const wallet=syntheticWallet(u);
      db.prepare('INSERT INTO users VALUES(?,?,?)').run(wallet,time,time);
      db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(contentHash({session:u}),wallet,time+3600);
      db.prepare('INSERT INTO activity(wallet,action,tx_hash,created_at) VALUES(?,?,?,?)').run(wallet,'create',contentHash({tx:u}),time);
    }
    const reviewerWallets=[];
    for(let r=0;r<reviewers;r++){
      const wallet=syntheticWallet(1_000_000+r);reviewerWallets.push(wallet);
      db.prepare('INSERT INTO reviewers VALUES(?,?,?,NULL)').run(wallet,syntheticWallet(0),time);
    }
    for(let i=0;i<drafts;i++)insertDraft(db,{index:i,owner:syntheticWallet(i%users),reviewer:reviewerWallets[i%reviewers],time:time+i});
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
}
