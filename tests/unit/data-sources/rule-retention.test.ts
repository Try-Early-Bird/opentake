import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate,migrations} from '../../../src/main/migrations';
import {pruneRuleHistory} from '../../../src/main/strategies/rule-retention';
const now=Date.UTC(2026,9,19),day=86400000;
async function fixture(upgrade=false){
 const db=new PGlite();await migrate(db,upgrade?migrations.filter(item=>item.version<=90):migrations);
 const take=randomUUID(),strategy=randomUUID(),version=randomUUID(),rule=randomUUID();
 await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners",[version,strategy]);
 await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Retention fixture','{}',$2 FROM local_owners",[take,strategy]);
 await db.query("INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) VALUES($1,1,$2,0,'{}')",[take,version]);
 const insert=async(key:string,created=now,status='expired',expires=now+day,padding=0)=>db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence)
 VALUES($1,$2,1,$3,$4,$5,$6,$7,'{}',$8) RETURNING id`,[randomUUID(),take,rule,key,new Date(created),new Date(expires),status,JSON.stringify({fixture:'x'.repeat(padding)})]);
 return {db,insert};
}
test('retention deletes aged finished evidence, expires abandoned work and preserves unexpired pending records',async()=>{
 const f=await fixture();try{
  await f.insert('old',now-31*day);await f.insert('recent',now-day);
  await f.insert('pending',now-40*day,'context_pending');await f.insert('shadow',now-40*day,'shadow');
  await f.insert('abandoned',now-40*day,'context_pending',now-1);
  expect(await f.db.transaction(tx=>pruneRuleHistory(tx,now))).toEqual({deleted:2});
  expect((await f.db.query<{firing_key:string}>('SELECT firing_key FROM strategy_rule_action_requests ORDER BY firing_key')).rows.map(row=>row.firing_key)).toEqual(['pending','recent','shadow']);
  expect((await f.db.query('SELECT * FROM strategy_rule_firing_receipts')).rows).toHaveLength(5);
  expect((await f.insert('old')).rows).toHaveLength(0);
  await expect(f.db.query("DELETE FROM strategy_rule_firing_receipts WHERE firing_key='old'")).rejects.toThrow();
 }finally{await f.db.close();}
});
test('age-only cleanup is batched and preserves recent large records and the exact retention boundary',async()=>{
 const f=await fixture();try{
  await f.insert('oldest',now-33*day);await f.insert('middle',now-32*day);await f.insert('newest',now-31*day);
  await f.insert('pending',now-40*day,'context_pending',now+day);
  await f.insert('recent-large',now-day,'expired',now,250000);
  await f.insert('boundary',now-30*day);
  const policy={retentionDays:30,batchSize:2};
  expect(await f.db.transaction(tx=>pruneRuleHistory(tx,now,policy))).toEqual({deleted:2});
  expect((await f.db.query('SELECT firing_key FROM strategy_rule_action_requests ORDER BY firing_key')).rows).toEqual([{firing_key:'boundary'},{firing_key:'newest'},{firing_key:'pending'},{firing_key:'recent-large'}]);
  expect(await f.db.transaction(tx=>pruneRuleHistory(tx,now,policy))).toEqual({deleted:1});
  expect(await f.db.transaction(tx=>pruneRuleHistory(tx,now,policy))).toEqual({deleted:0});
  expect((await f.db.query('SELECT firing_key FROM strategy_rule_action_requests ORDER BY firing_key')).rows).toEqual([{firing_key:'boundary'},{firing_key:'pending'},{firing_key:'recent-large'}]);
 }finally{await f.db.close();}
});
test('migration backfills receipts and transaction rollback cannot claim an event without its evidence',async()=>{
 const f=await fixture(true);try{
  await f.insert('before-upgrade',now-31*day);await migrate(f.db);
  await f.db.transaction(tx=>pruneRuleHistory(tx,now));expect((await f.insert('before-upgrade')).rows).toHaveLength(0);
  await expect(f.db.transaction(async tx=>{
   await tx.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence)
    SELECT gen_random_uuid(),take_id,draft_revision,rule_id,'rollback',created_at,created_at,'expired','{}','{}' FROM strategy_rule_firing_receipts LIMIT 1`);
   throw Error('rollback fixture');
  })).rejects.toThrow('rollback fixture');
  expect((await f.db.query("SELECT * FROM strategy_rule_firing_receipts WHERE firing_key='rollback'")).rows).toHaveLength(0);
  expect((await f.insert('rollback')).rows).toHaveLength(1);
 }finally{await f.db.close();}
});

test('expiry never takes a request owned by a working or attention trade job, whatever approval_pending is',async()=>{
 const f=await fixture();try{
  const connection=(await f.db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected',$1 FROM local_owners RETURNING id",[randomUUID()])).rows[0].id;
  const account=(await f.db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,$2,'synthetic') RETURNING id",[connection,randomUUID()])).rows[0].id;
  const take=(await f.db.query<{take_id:string}>('SELECT take_id FROM strategy_rule_draft_revisions')).rows[0].take_id;
  for(const state of ['working','attention','completed']){
   const id=(await f.insert(state,now-day,'shadow',now-1)).rows[0].id;
   await f.db.query('INSERT INTO strategy_rule_trades(request_id,take_id,account_id,phase,state,approval_pending) VALUES($1,$2,$3,$4,$5,false)',[id,take,account,'buy',state]);
  }
  await f.db.transaction(tx=>pruneRuleHistory(tx,now));
  expect((await f.db.query('SELECT firing_key,status FROM strategy_rule_action_requests ORDER BY firing_key')).rows).toEqual([{firing_key:'attention',status:'shadow'},{firing_key:'completed',status:'expired'},{firing_key:'working',status:'shadow'}]);
 }finally{await f.db.close();}
});
test('aged requests named by an order review or a live notification are kept; pruned links release them',async()=>{
 const f=await fixture();try{
  const reviewed=(await f.insert('reviewed',now-40*day,'executed')).rows[0].id;
  const notified=(await f.insert('notified',now-40*day,'notified')).rows[0].id;
  await f.insert('plain',now-40*day,'executed');
  const take=(await f.db.query<{take_id:string}>('SELECT take_id FROM strategy_rule_draft_revisions')).rows[0].take_id;
  // Synthetic order review: only its rule link matters here, so referential checks are skipped for the insert.
  await f.db.exec('SET session_replication_role = replica');
  await f.db.query("INSERT INTO coinbase_order_reviews(id,take_id,account_id,allocation_id,version_id,authority,claims_hash,payload,state,created_at,expires_at) VALUES($1,$2,$3,$4,$5,'fixture','fixture',$6,'confirmed',now(),now())",[randomUUID(),take,randomUUID(),randomUUID(),randomUUID(),JSON.stringify({rebalance:{scheduledOn:'2026-10-01',trigger:'rule',ruleRequestId:reviewed}})]);
  await f.db.exec('SET session_replication_role = origin');
  await f.db.query("SELECT record_local_notification($1::jsonb)",[JSON.stringify({kind:'rule_notification',tier:'know_today',requiresAction:false,eventKey:notified,context:{takeId:take},source:{type:'rule',id:notified},occurredAt:new Date(now).toISOString(),title:'Fixture',body:'Fixture'})]);
  expect(await f.db.transaction(tx=>pruneRuleHistory(tx,now))).toEqual({deleted:1});
  expect((await f.db.query('SELECT firing_key FROM strategy_rule_action_requests ORDER BY firing_key')).rows).toEqual([{firing_key:'notified'},{firing_key:'reviewed'}]);
  await f.db.query('UPDATE notifications SET pruned=true');
  expect(await f.db.transaction(tx=>pruneRuleHistory(tx,now))).toEqual({deleted:1});
  expect((await f.db.query('SELECT firing_key FROM strategy_rule_action_requests')).rows).toEqual([{firing_key:'reviewed'}]);
 }finally{await f.db.close();}
});
test('migration 98 indexes inbox cleanup and per-Take request timelines',async()=>{
 const f=await fixture();try{
  const indexes=(await f.db.query<{indexname:string;indexdef:string}>("SELECT indexname,indexdef FROM pg_indexes WHERE indexname IN ('strategy_rule_event_received','strategy_rule_action_take_created') ORDER BY indexname")).rows;
  expect(indexes.map(row=>row.indexname)).toEqual(['strategy_rule_action_take_created','strategy_rule_event_received']);
  expect(indexes[0].indexdef).toContain('(take_id, created_at, id)');expect(indexes[1].indexdef).toContain('(received_at)');
 }finally{await f.db.close();}
});
