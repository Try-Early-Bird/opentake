import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {createManagedSourceSettings} from '../../../src/main/data-sources/managed-settings';
import {createCoinbaseAccountSettings} from '../../../src/main/data-sources/coinbase-account-settings';
import {defaultCoinbaseAccountConfig} from '../../../src/shared/coinbase-field-mappings';
test('accounts own independent cadence and feed selection with fixed mappings and optimistic revisions',async()=>{
 const db=new PGlite();try{
  await migrate(db);const database={use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)};
  const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','synthetic' FROM local_owners RETURNING id")).rows[0].id;
  const [a,b]=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,'a','A'),($1,'b','B') RETURNING id",[connection])).rows.map(row=>row.id);
  const settings=createManagedSourceSettings(database);
  const [first]=await settings.list(a),[second]=await settings.list(b);
  expect(first.accountId).toBe(a);expect(second.accountId).toBe(b);
  const edited=await settings.save({...first,collection:'off',intervalMs:45000});
  expect((await settings.list(a))[0]).toEqual(edited);expect((await settings.list(b))[0]).toEqual(second);
  await expect(settings.save(first)).rejects.toThrow('changed');
  await expect(settings.save({...edited,id:'robinhood-prices'})).rejects.toThrow('unavailable');
  const sources=createCoinbaseAccountSettings(database),configA=await sources.load(a),configB=await sources.load(b);
  const next=await sources.save({...configA,config:{reads:{portfolio:true,positionDetails:false,orders:true,fills:false,history:false}}});
  expect((await sources.load(a)).config).toEqual(next.config);expect(await sources.load(b)).toEqual(configB);
  await expect(sources.save(configA)).rejects.toThrow('changed');
  await expect(sources.save({...next,config:{...next.config,mappings:{price:['bad']}}})).rejects.toThrow();
  await expect(sources.save({...next,config:{reads:{...next.config.reads,portfolio:false,history:true}}})).rejects.toThrow();
  expect((await createCoinbaseAccountSettings(database).load(a)).config).toEqual(next.config);
 }finally{await db.close();}
});

test('an unreadable saved Coinbase account config syncs with the defaults, is flagged, and saving replaces it',async()=>{
 const db=new PGlite();try{
  await migrate(db);const database={use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)};
  const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','synthetic' FROM local_owners RETURNING id")).rows[0].id;
  const a=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,'a','A') RETURNING id",[connection])).rows[0].id;
  await db.query('INSERT INTO coinbase_account_source_settings(account_id,revision,config) VALUES($1,3,$2)',[a,JSON.stringify({reads:{portfolio:true}})]);
  const sources=createCoinbaseAccountSettings(database),loaded=await sources.load(a);
  expect(loaded).toEqual({accountId:a,revision:3,config:defaultCoinbaseAccountConfig,unreadable:true});
  // The background sync reads `config.reads` directly; it now gets a complete config instead of throwing.
  expect(Object.values(loaded.config.reads).every(value=>typeof value==='boolean')).toBe(true);
  const saved=await sources.save({accountId:a,revision:loaded.revision,config:{reads:{...defaultCoinbaseAccountConfig.reads,fills:false}}});
  expect(saved).toEqual({accountId:a,revision:4,config:{reads:{...defaultCoinbaseAccountConfig.reads,fills:false}}});
 }finally{await db.close();}
});

test('runtime cadence and pause decisions are independent for two accounts',async()=>{
 const {createAccountPollGate}=await import('../../../src/main/data-sources/account-polls');
 let now=0;const records=new Map(['a','b'].map(accountId=>[accountId,{accountId,id:'coinbase-account-sync' as const,collection:'automatic' as 'automatic'|'off',intervalMs:accountId==='a'?5000:60000,revision:1}]));
 const gate=createAccountPollGate({list:async id=>[records.get(id)!]},()=>now);
 expect(await gate.due('coinbase-account-sync','a')).toBe(true);expect(await gate.due('coinbase-account-sync','b')).toBe(true);
 now=5000;expect(await gate.due('coinbase-account-sync','a')).toBe(true);expect(await gate.due('coinbase-account-sync','b')).toBe(false);
 records.get('a')!.collection='off';now=60000;
 expect(await gate.due('coinbase-account-sync','a')).toBe(false);expect(await gate.due('coinbase-account-sync','b')).toBe(true);
 records.get('a')!.collection='automatic';gate.changed('coinbase-account-sync','a');expect(await gate.due('coinbase-account-sync','a')).toBe(true);
});
