import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../src/main/migrations';
import {readActivityPage} from '../../src/main/account-sync/activity-page';
for(const venue of ['robinhood','coinbase'])test(`${venue} activity pages beyond 100 with equal timestamps, new arrivals and account isolation`,async()=>{
 const db=new PGlite();try{
  await migrate(db);
  const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,$1,'connected','synthetic' FROM local_owners RETURNING id",[venue])).rows[0].id;
  const account=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,'fixture','test') RETURNING id",[connection])).rows[0].id;
  const other=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,'other','test') RETURNING id",[connection])).rows[0].id;
  await db.query("INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,$2,'order','equity','filled',true,'{}',now(),now())",[account,venue]);
  await db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at)
   SELECT $1,$2,'fill-'||n,'order','equity',jsonb_build_object('providerExecutionRef','fill-'||n,'orderRef','order','occurredAt','2026-10-12T12:00:00.000Z','quantity','1','price','10','symbol','BTC','assetClass','equity'),'2026-10-12T12:00:00Z' FROM generate_series(1,125) n`,[account,venue]);
  if(venue==='coinbase')await db.query("INSERT INTO coinbase_transaction_history(account_id,checked_at,state,data) VALUES($1,now(),'complete',$2)",[account,JSON.stringify({transactions:[{id:'transfer',type:'send',asset:'USDC',amount:'-5',status:'completed',occurredAt:'2026-10-11T12:00:00Z'},{id:'duplicate',type:'advanced_trade_fill',orderRef:'order',occurredAt:'2026-10-12T12:00:00Z'}]})]);
  const first=await readActivityPage(db,account);expect(first.executions).toHaveLength(50);expect(first.nextCursor).not.toBeNull();
  await db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,$2,'new','order','equity','{"providerExecutionRef":"new"}','2026-10-13T12:00:00Z')`,[account,venue]);
  const second=await readActivityPage(db,account,first.nextCursor),third=await readActivityPage(db,account,second.nextCursor);
  expect(second.executions).toHaveLength(50);expect(third.executions).toHaveLength(25);expect(third.nextCursor).toBeNull();
  expect(new Set([...first.executions,...second.executions,...third.executions].map(e=>e.providerExecutionRef)).size).toBe(125);
  expect(third.accountTransactions?.map(t=>t.id)).toEqual(venue==='coinbase'?['transfer']:[]);
  expect((await readActivityPage(db,other)).executions).toEqual([]);
 }finally{await db.close();}
});
