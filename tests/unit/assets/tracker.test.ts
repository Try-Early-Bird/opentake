import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {trackedRobinhoodAssets} from '../../../src/main/assets/tracker';
import {marketKey} from '../../../src/shared/search';
import {createCryptoOrderJournal} from '../../../src/main/orders/crypto-journal';
const identity={venue:'robinhood',instance:'production',kind:'crypto',reference:'pair-btc'};
async function fixture(){
 const db=new PGlite();await migrate(db);
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic','test',true,true) RETURNING id`,[connection])).rows[0].id;
 const observe=async(kind:'crypto'|'equity',data:unknown[],at:string)=>{
  const run=randomUUID(),snapshot=randomUUID(),resource=kind+'_positions';
  await db.query(`INSERT INTO account_sync_runs(id,account_id,resource,state,started_at,finished_at) VALUES($1,$2,$3,'completed',$4,$4)`,[run,account,resource,at]);
  await db.query(`INSERT INTO position_snapshots(id,account_id,asset_class,payload_hash,data) VALUES($1,$2,$3,$5,$4)`,[snapshot,account,kind,JSON.stringify(data),snapshot]);
  await db.query(`INSERT INTO account_observations(id,run_id,account_id,resource,observed_at,position_snapshot_id) VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),run,account,resource,at,snapshot]);
 };
 return {db,account,observe};
}
test('holds distinct same-ticker identities, ignores quote-only rows and uses latest persisted observation',async()=>{
 const f=await fixture();try{
  await f.observe('equity',[{instrumentRef:'provider-equity',symbol:'BTC',quantity:'2'}],'2026-10-15T12:00:00Z');
  await f.observe('crypto',[{instrumentRef:marketKey({identity}),symbol:'BTC',quantity:'0.01',priceObservedAt:'2026-10-15T12:00:00Z'},
   {instrumentRef:marketKey({identity:{...identity,reference:'pair-eth'}}),symbol:'ETH',quantity:'0'}],'2026-10-15T12:00:01Z');
  const assets=await trackedRobinhoodAssets(f.db,f.account);
  expect(assets).toHaveLength(2);
  expect(new Set(assets.map(a=>a.key)).size).toBe(2);
  expect(assets.find(a=>a.identity.kind==='crypto')).toMatchObject({reasons:['holding'],accountIds:[f.account],observedAt:'2026-10-15T12:00:01.000Z',priceObservedAt:'2026-10-15T12:00:00.000Z'});
  // Failed sync creates no new observation, so durable holdings remain tracked.
  expect(await trackedRobinhoodAssets(f.db,f.account)).toEqual(assets);
  await f.observe('crypto',[],'2026-10-16T12:00:00Z');
  expect((await trackedRobinhoodAssets(f.db,f.account)).map(a=>a.identity.kind)).toEqual(['equity']);
  await f.db.query('UPDATE linked_accounts SET selected=false WHERE id=$1',[f.account]);
  expect(await trackedRobinhoodAssets(f.db)).toEqual([]);
 }finally{await f.db.close();}
});
test('targets and unresolved orders stay relevant without holdings; terminal/archived sources disappear',async()=>{
 const f=await fixture();try{
  const strategy=randomUUID(),version=randomUUID();
  await f.db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,[version,strategy,JSON.stringify({target:{weights:[{instrument:{venue:'robinhood',symbol:'BTC-USD',market:identity},bps:10000}],cashBps:0}})]);
  await f.db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
  const journal=createCryptoOrderJournal({use:async fn=>fn(f.db)});
  const intent=await journal.review({accountId:f.account,order:{currency_pair_id:'pair-btc',side:'buy',type:'market',dollar_amount:'5',time_in_force:'gtc'},maximumDebit:'5.06',review:{symbol:'BTC-USD'}});
  await f.db.query(`UPDATE order_intents SET status='placement_unknown' WHERE id=$1`,[intent.id]);
  let assets=await trackedRobinhoodAssets(f.db,f.account);
  expect(assets).toHaveLength(1);
  expect(assets[0]).toMatchObject({reasons:['open_order','take_target'],strategyIds:[strategy],accountIds:[f.account]});
  await f.db.query(`UPDATE strategies SET archived_at=now() WHERE id=$1`,[strategy]);
  assets=await trackedRobinhoodAssets(f.db,f.account);
  expect(assets[0].reasons).toEqual(['open_order']);
  await f.db.query(`UPDATE order_intents SET status='rejected' WHERE id=$1`,[intent.id]);
  expect(await trackedRobinhoodAssets(f.db,f.account)).toEqual([]);
 }finally{await f.db.close();}
});
test('external equity orders remain tracked without a Take or local intent',async()=>{
 const f=await fixture();try{
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','external','equity','queued',false,'{"symbol":"VTI"}',now(),now())`,[f.account]);
  expect(await trackedRobinhoodAssets(f.db,f.account)).toMatchObject([{symbol:'VTI',reasons:['open_order']}]);
  expect(await trackedRobinhoodAssets(f.db,randomUUID())).toEqual([]);
  await f.db.query(`UPDATE account_orders SET terminal=true,state='filled' WHERE account_id=$1`,[f.account]);
  expect(await trackedRobinhoodAssets(f.db,f.account)).toEqual([]);
 }finally{await f.db.close();}
});

test('an allocation keeps its applied targets tracked after the Take is archived',async()=>{
 const f=await fixture();try{
  const strategy=randomUUID(),version=randomUUID(),allocation=randomUUID();
  await f.db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}',$3,'{}','{}' FROM local_owners`,[version,strategy,JSON.stringify({target:{weights:[{instrument:{venue:'robinhood',symbol:'BTC-USD',market:identity},bps:10000}],cashBps:0}})]);
  await f.db.query(`UPDATE strategies SET status='committed',current_version_id=$2,archived_at=now() WHERE id=$1`,[strategy,version]);
  await f.db.query(`INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,created_at,updated_at) VALUES($1,$2,$3,$4,'USD','paused',now(),now())`,[allocation,f.account,strategy,version]);
  expect(await trackedRobinhoodAssets(f.db,f.account)).toMatchObject([{symbol:'BTC-USD',reasons:['take_target'],accountIds:[f.account],strategyIds:[strategy]}]);
  await f.db.query(`UPDATE strategy_allocations SET status='closed' WHERE id=$1`,[allocation]);
  expect(await trackedRobinhoodAssets(f.db,f.account)).toEqual([]);
 }finally{await f.db.close();}
});
