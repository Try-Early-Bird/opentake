import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../src/main/migrations';
import {syncCoinbaseHealthNotifications} from '../../src/main/coinbase/sync-notifications';
import {createNotifications} from '../../src/main/notifications';

test('Coinbase sync alerts isolate accounts, deduplicate retries/restarts and resolve only on recovery',async()=>{
 const db=new PGlite();await migrate(db);let now=Date.parse('2026-10-11T16:00:00Z');
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const service=createNotifications(database,{now:()=>now,deliver:()=>{},badge:()=>{},openDesktop:()=>{}});
 try{
  const create=async(label:string)=>{
   const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref,maintenance_enabled) SELECT id,'coinbase','connected',$1,true FROM local_owners RETURNING id",[label])).rows[0].id;
   const account=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,available) VALUES($1,$2,$2,true) RETURNING id",[connection,label])).rows[0].id;
   await db.query("INSERT INTO coinbase_portfolio_sync(account_id,state,attempted_at,failure_count,error_code) VALUES($1,'failed',$2,2,'provider')",[account,new Date(now).toISOString()]);
   return {connection,account};
  };
  const a=await create('First portfolio'),b=await create('Second portfolio');
  const notices=async()=>(await service.list()).items.filter(i=>i.kind==='account_data_stale');
  await service.tick();expect(await notices()).toHaveLength(0);
  await db.query('UPDATE coinbase_portfolio_sync SET failure_count=3 WHERE account_id=$1',[a.account]);
  now+=6000;await service.tick();
  let items=await notices();expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({context:{venue:'coinbase',accountId:a.account,connectionId:a.connection},requiresAction:true,resolvedAt:null});
  expect(items[0].body).toContain('First portfolio');
  expect(await service.target(items[0].id)).toEqual({type:'connection',connectionId:a.connection,venue:'coinbase'});
  await syncCoinbaseHealthNotifications(db,now,true);expect(await notices()).toHaveLength(1);
  await db.query("UPDATE coinbase_portfolio_sync SET state='running' WHERE account_id=$1",[a.account]);
  await syncCoinbaseHealthNotifications(db,now);expect((await notices())[0].resolvedAt).toBeNull();
  // Balances succeeded but history/activity still failed: aggregate count preserves the alert.
  await db.query("UPDATE coinbase_portfolio_sync SET state='completed',failure_count=4 WHERE account_id=$1",[a.account]);
  await syncCoinbaseHealthNotifications(db,now);expect((await notices())[0].resolvedAt).toBeNull();
  await db.query("UPDATE coinbase_portfolio_sync SET failure_count=0 WHERE account_id=$1",[a.account]);
  await syncCoinbaseHealthNotifications(db,now);expect((await notices())[0].resolvedAt).not.toBeNull();
  await db.query("UPDATE coinbase_portfolio_sync SET state='failed',failure_count=3");
  now+=6000;await syncCoinbaseHealthNotifications(db,now);
  items=await notices();expect(items).toHaveLength(3);expect(items.filter(i=>i.resolvedAt===null)).toHaveLength(2);
  await db.query("UPDATE platform_connections SET status='reauth_required' WHERE id=$1",[a.connection]);
  await syncCoinbaseHealthNotifications(db,now);
  expect((await notices()).filter(i=>i.resolvedAt===null)).toHaveLength(1);
  expect((await service.list()).items.filter(i=>i.kind==='connection_attention'&&i.resolvedAt===null)).toHaveLength(1);
  await db.query("UPDATE platform_connections SET status='disconnected' WHERE id=$1",[b.connection]);
  await syncCoinbaseHealthNotifications(db,now);expect((await notices()).filter(i=>i.resolvedAt===null)).toHaveLength(0);
 }finally{await service.stop();await db.close();}
});
