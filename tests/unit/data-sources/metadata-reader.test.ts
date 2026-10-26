import { test, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../src/main/migrations';
import { readMarketMetadata } from '../../../src/main/data-sources/metadata-reader';
import { createSourceRepository } from '../../../src/main/data-sources/repository';
import { sourceConfigSchema } from '../../../src/main/data-sources/config';
import { applyDestination } from '../../../src/main/data-sources/destinations';
import { createCustomDataSources } from '../../../src/main/data-sources/service';
import type { DataObservation } from '../../../src/shared/data-sources';
const market = {venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'};
const config = sourceConfigSchema.parse({name:'Fixture',endpoint:'https://fixture.example/value',collection:'when-open',feeds:[{id:'metadata',name:'Sentiment',unit:'points',mapping:{kind:'event',fields:{score:{path:['score'],type:'number'}}},storage:{mode:'latest',fields:['score']},destination:{kind:'market-metadata',market,namespace:'sentiment',maxAgeMs:60000}}]});
test('metadata reads isolate exact market/owner, expose freshness and fence paused or obsolete revisions', async () => {
 const db = new PGlite();
 try {
  await migrate(db);
  const owner = (await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
  const repo = createSourceRepository({use:work=>work(db)}), source = await repo.save(owner,config);
  await repo.validate(owner,source.id,1); await repo.enable(owner,source.id,1,true);
  const now = Date.now();
  const observation: DataObservation = {sourceId:source.id,feedId:'metadata',configVersion:1,schemaVersion:1,adapterId:'custom-http',adapterVersion:'1',epoch:1,unit:'points',eventTime:now,receivedAt:now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields:{score:62,ignored:'hidden'}}};
  await db.transaction(tx=>applyDestination(tx,owner,config.feeds[0],observation,now));
  expect((await readMarketMetadata(db,owner,market,now)).namespaces).toEqual([{namespace:'sentiment',sourceId:source.id,revision:1,feedId:'metadata',fields:{score:62},updatedAt:now,fieldUpdates:{score:{updatedAt:now,eventTime:now,quality:'fresh'}},receivedAt:now,eventTime:now,quality:'fresh',maxAgeMs:60000}]);
  expect((await readMarketMetadata(db,owner,market,now+60001)).namespaces[0].quality).toBe('stale');
  expect((await readMarketMetadata(db,owner,market,now-1)).namespaces[0].quality).toBe('stale');
  expect((await readMarketMetadata(db,'11111111-1111-4111-8111-111111111111',market,now)).namespaces).toEqual([]);
  for(const change of [{venue:'coinbase'},{instance:'sandbox'},{kind:'crypto'},{reference:'MSFT'},{pair:'AAPL-USD'}]) expect((await readMarketMetadata(db,owner,{...market,...change},now)).namespaces).toEqual([]);
  await repo.enable(owner,source.id,1,false);
  expect((await readMarketMetadata(db,owner,market,now)).namespaces).toEqual([]);
  await repo.enable(owner,source.id,1,true);
  await repo.save(owner,config,{id:source.id,revision:1});
  await repo.validate(owner,source.id,2); await repo.enable(owner,source.id,2,true);
  expect((await readMarketMetadata(db,owner,market,now)).namespaces).toEqual([]);
  // Retained rows remain intact; reads do not delete historical provenance.
  expect((await db.query('SELECT fields FROM market_source_metadata')).rows).toEqual([{fields:{score:62}}]);
 } finally { await db.close(); }
});
test('host metadata read validates input, resolves its own owner and never starts network collection', async () => {
 const db = new PGlite(); await migrate(db);
 const read=vi.fn(async()=>({}));
 const secrets={available:()=>false,get:async()=>{throw Error('No secrets');},set:async()=>{throw Error();},delete:async()=>{throw Error();},has:async()=>false};
 const service=createCustomDataSources({use:work=>work(db)},secrets,{read});
 const call=(input:unknown)=>service.dispatch('dataSources:configure',[input],'11111111-1111-4111-8111-111111111111');
 try {
  expect(await call({action:'market-metadata',market})).toEqual({market,namespaces:[],truncated:false});
  await expect(call({action:'market-metadata',market,ownerId:'spoofed'})).rejects.toThrow();
  await expect(call({action:'market-metadata',market:{...market,reference:''}})).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
 } finally {await service.close();await db.close();}
});

test.each(['http','websocket'] as const)('%s metadata tracks per-field refresh times without refreshing omitted or null fields',async(transport)=>{
 const db=new PGlite();await migrate(db);const start=Date.now();
 try{
  const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
  const repo=createSourceRepository({use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)});
  const sourceConfig=sourceConfigSchema.parse({...config,feeds:[{...config.feeds[0],mapping:{kind:'event',fields:{score:{path:['score'],type:'number'},label:{path:['label'],type:'string'}}},storage:{mode:'latest',fields:['score','label']}}]});
  const savedConfig=transport==='http'?sourceConfig:{transport:'websocket' as const,name:'Metadata stream',collection:'when-open' as const,connection:{endpoint:'wss://fixture.example/metadata',auth:{mode:'none' as const},subscription:{body:{op:'subscribe'}},acknowledgement:{success:{path:['op'],equals:'ok'},failure:{path:['op'],equals:'error'}}},feeds:sourceConfig.feeds};
  const source=await repo.save(owner,savedConfig);await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);
  const write=(fields:Record<string,string|number|null>,time:number,dry=false)=>db.transaction(tx=>applyDestination(tx,owner,sourceConfig.feeds[0],{sourceId:source.id,feedId:'metadata',configVersion:1,schemaVersion:1,adapterId:'custom-http',adapterVersion:'1',epoch:1,unit:'points',eventTime:time-100,receivedAt:time,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields}},time,dry));
  await write({score:1,label:'old'},start);
  await write({score:2,label:null},start+61000);
  let value=(await readMarketMetadata(db,owner,market,start+61000)).namespaces[0];
  expect(value.updatedAt).toBe(start+61000);
  expect(value.fields).toEqual({score:2,label:'old'});
  expect(value.fieldUpdates).toEqual({score:{updatedAt:start+61000,eventTime:start+60900,quality:'fresh'},label:{updatedAt:start,eventTime:start-100,quality:'stale'}});
  await write({label:'preview'},start+62000,true);
  await write({score:null},start+63000);
  await write({score:99},start+1000);
  expect((await readMarketMetadata(db,owner,market,start+61000)).namespaces[0]).toEqual(value);
  // Pre-migration rows have no evidence for individual field timestamps.
  await db.query("UPDATE market_source_metadata SET field_timestamps='{}'");
  value=(await readMarketMetadata(db,owner,market,start+61000)).namespaces[0];
  expect(value.fieldUpdates.label).toEqual({updatedAt:null,eventTime:null,quality:'stale'});
 }finally{await db.close();}
});
