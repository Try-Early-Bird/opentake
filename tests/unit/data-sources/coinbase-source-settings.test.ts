import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate,prepareRestoredDatabase} from '../../../src/main/migrations';
import {createCoinbaseSourceSettings} from '../../../src/main/data-sources/coinbase-stream/source-settings';
import {createCustomDataSources} from '../../../src/main/data-sources/service';
import {randomUUID} from 'node:crypto';
test('Coinbase source is seeded once, revisioned, persisted, isolated from generic sockets and rejects stale or incompatible edits',async()=>{
 const db=new PGlite();let custom:ReturnType<typeof createCustomDataSources>|undefined;
 try{
  await migrate(db);const database={use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)};
  const settings=createCoinbaseSourceSettings(database),source=await settings.load();
  expect(source).toMatchObject({revision:1,enabled:true,validated:true,config:{provider:{subscriptions:{holdings:true,views:true,products:[]}}}});
  expect((await settings.load()).id).toBe(source.id);
  const saved=await settings.save({revision:source.revision,config:{...source.config,name:'My market feed',collection:'off',provider:{kind:'coinbase-market',subscriptions:{holdings:false,views:true,products:['SOL-USD']}}}});
  expect(saved).toMatchObject({revision:2,enabled:false,validated:true,config:{name:'My market feed'}});
  expect(await createCoinbaseSourceSettings(database).load()).toEqual(saved);
  await expect(settings.save({revision:1,config:source.config})).rejects.toThrow('changed');
  for(const config of [
   {...source.config,provider:{kind:'coinbase-market',subscriptions:{holdings:true,views:true,products:['BTC-USD','BTC-USD']}}},
   {...source.config,connection:{...source.config.connection,endpoint:'wss://example.com'}},
   {...source.config,provider:undefined},
  ])await expect(settings.save({revision:2,config})).rejects.toThrow();
  custom=createCustomDataSources(database,{} as never);
  await custom.start();
  const client=randomUUID();
  expect(await custom.dispatch('dataSources:configure',[{action:'websocket-list'}],client)).toEqual([]);
  expect(await custom.dispatch('dataSources:list',[],client)).toEqual([]);
  await expect(custom.dispatch('dataSources:configure',[{action:'save',config:source.config}],client)).rejects.toThrow('provider source editor');
  await expect(custom.dispatch('dataSources:configure',[{action:'enable',id:source.id,revision:2,enabled:true}],client)).rejects.toThrow('provider source editor');
  const {provider,...generic}=source.config;
  await expect(custom.dispatch('dataSources:configure',[{action:'save',config:generic,existing:{id:source.id,revision:2}}],client)).rejects.toThrow('provider source editor');
  expect((await db.query('SELECT * FROM data_sources')).rows).toHaveLength(1);
  expect((await db.query('SELECT * FROM data_source_revisions')).rows).toHaveLength(2);
  await prepareRestoredDatabase(db);
  expect(await settings.load()).toMatchObject({enabled:false,validated:false});
 }finally{await custom?.close();await db.close();}
},30000);

test('changed price mappings require a fresh matching preview before persisting',async()=>{
 const db=new PGlite();try{
  await migrate(db);const settings=createCoinbaseSourceSettings({use:work=>work(db)}),source=await settings.load();
  const config={...source.config,provider:{...source.config.provider!,priceMappings:{product:['product_id'],price:['customPrice'],time:['time']}}};
  await expect(settings.save({revision:source.revision,config})).rejects.toThrow('Preview');
  const now=Date.now(),text=JSON.stringify({channel:'market_trades',events:[{type:'update',trades:[{product_id:'BTC-USD',customPrice:'123',time:new Date(now).toISOString()}]}]});
  expect(settings.preview(config,{cursor:1,total:1,startedAt:now,messages:[{id:1,type:'json',text,bytes:text.length,receivedAt:now}]})).toMatchObject({product:'BTC-USD',price:'123'});
  const saved=await settings.save({revision:source.revision,config:{...config,collection:'off'}});
  expect(saved.config.provider?.priceMappings.price).toEqual(['customPrice']);
 }finally{await db.close();}
});
