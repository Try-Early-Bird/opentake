import {test,expect,vi} from 'vitest';
import {createCoinbaseSourceSettings} from '../../../src/main/data-sources/coinbase-stream/source-settings';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createDataSourceChat} from '../../../src/main/data-sources/chat';
import {createSourceRepository} from '../../../src/main/data-sources/repository';
import {callOpentakeTool} from '../../../src/main/opentake-mcp/server';
import {toolCatalog} from '../../../src/main/opentake-mcp/catalog';
import type {DataSnapshot} from '../../../src/shared/data-sources';
test('source tools are read-only and reject endpoints and extraneous arguments',async()=>{
 const dataSourceList=vi.fn(),dataSourceRead=vi.fn(),services={dataSourceList,dataSourceRead,status:vi.fn(),read:vi.fn()};
 for(const name of ['opentake_list_data_sources','opentake_read_data_source'])expect(toolCatalog().find(t=>t.name===name)?.annotations.readOnlyHint).toBe(true);
 expect((await callOpentakeTool(services,'opentake_list_data_sources',{})).isError).not.toBe(true);
 expect((await callOpentakeTool(services,'opentake_list_data_sources',{endpoint:'https://example.com'})).isError).toBe(true);
 expect((await callOpentakeTool(services,'opentake_read_data_source',{sourceId:randomUUID(),revision:1,feedId:'score',endpoint:'https://example.com'})).isError).toBe(true);
 expect(dataSourceList).toHaveBeenCalledTimes(1);expect(dataSourceRead).not.toHaveBeenCalled();
});
test('chat discovers and reads sources without bindings; hides configuration and fences revisions and stopped runs',async()=>{
 const db=new PGlite();await migrate(db);const database={use:async<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const take=randomUUID(),run=randomUUID();let active=true,snapshot:DataSnapshot|null=null;
 const peek=vi.fn(()=>[snapshot]),chat=createDataSourceChat(database,peek,()=>[],()=>active),repo=createSourceRepository(database);
 try{
  const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
  await db.query("INSERT INTO takes(id,owner_id,title,selection) VALUES($1,$2,'Fixture','{}')",[take,owner]);
  await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running','{}')",[run,take,randomUUID()]);
  const source=await repo.save(owner,{name:'Sentiment',endpoint:'https://example.com/private',collection:'automatic',feeds:[{id:'score',name:'Score',unit:'score',mapping:{kind:'metric',valuePath:['secret_path']},storage:{mode:'latest',fields:['value']}}]});
  await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);
  const listed=JSON.stringify(await chat.list(run));expect(listed).toContain('Sentiment');expect(listed).not.toContain('secret_path');expect(listed).not.toContain('example.com');
  const input={sourceId:source.id,revision:1,feedId:'score'};
  expect(await chat.read(run,input)).toMatchObject({quality:'missing',value:null});
  snapshot={quality:'fresh',connection:'live',issue:null,lastReceivedAt:1000,latest:{sourceId:source.id,feedId:'score',configVersion:1,schemaVersion:1,adapterId:'fixture',adapterVersion:'1',epoch:1,unit:'score',eventTime:1000,receivedAt:1000,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'metric',value:'0.7'}}};
  expect(await chat.read(run,input)).toMatchObject({quality:'fresh',value:{value:'0.7'},revision:1});
  await db.query("INSERT INTO data_source_latest(source_id,revision,feed_id,received_at,event_time,data) VALUES($1,1,'score',now(),now(),$2)",[source.id,JSON.stringify({fields:{value:'0.6'},unit:'score'})]);
  const live=snapshot;snapshot=null;expect(await chat.read(run,input)).toMatchObject({quality:'stale',origin:'retained',value:{fields:{value:'0.6'}}});snapshot=live;
  snapshot={...snapshot,quality:'stale'};expect(await chat.read(run,input)).toMatchObject({quality:'stale'});
  await expect(chat.read(run,{...input,revision:2})).rejects.toThrow('changed');
  await expect(chat.read(run,{...input,sourceId:randomUUID()})).rejects.toThrow('unavailable');
  await repo.enable(owner,source.id,1,false);expect(await chat.read(run,input)).toMatchObject({quality:'disabled',value:null});
  const coinbase=await createCoinbaseSourceSettings(database).load();
  const priceChat=createDataSourceChat(database,peek,()=>[{product:'BTC-USD',price:'123',eventTime:1000}],()=>active);
  expect(JSON.stringify(await priceChat.list(run))).toContain('Live market prices');
  expect(await priceChat.read(run,{sourceId:coinbase.id,revision:coinbase.revision,feedId:'prices'})).toMatchObject({quality:'fresh',values:[{product:'BTC-USD',price:'123'}]});
  const revoked=createDataSourceChat(database,()=>{active=false;return [live];},()=>[],()=>active);
  await repo.enable(owner,source.id,1,true);await expect(revoked.read(run,input)).rejects.toThrow('stopped');
  active=false;await expect(chat.list(run)).rejects.toThrow('stopped');await expect(chat.read(run,input)).rejects.toThrow('stopped');
  active=true;await db.query('UPDATE takes SET archived_at=now() WHERE id=$1',[take]);await expect(chat.list(run)).rejects.toThrow('unavailable');
 }finally{await db.close();}
});

test.each(['http','websocket'] as const)('%s chat reads committed metadata with independent field freshness, never an uncommitted live payload',async transport=>{
 const {createObservationStorage}=await import('../../../src/main/data-sources/storage');
 const db=new PGlite();await migrate(db);
 const database={use:async<T>(work:(db:PGlite)=>Promise<T>)=>work(db)};
 const start=Date.now(),clock=vi.spyOn(Date,'now').mockReturnValue(start);
 const storage=createObservationStorage(database,{automatic:false});
 try{
  const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
  const take=randomUUID(),run=randomUUID();
  await db.query("INSERT INTO takes(id,owner_id,title,selection) VALUES($1,$2,'Fixture','{}')",[take,owner]);
  await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running','{}')",[run,take,randomUUID()]);
  const market={venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'};
  const feeds=[{id:'metadata',name:'Sentiment',unit:'points',mapping:{kind:'event',fields:{score:{path:['private_score'],type:'number'},label:{path:['label'],type:'string'},hidden:{path:['hidden'],type:'string'}}},storage:{mode:'latest',fields:['score','label']},destination:{kind:'market-metadata',market,namespace:'sentiment',maxAgeMs:60000}}];
  const config=transport==='http'?{name:'Metadata',endpoint:'https://fixture.example/metadata',collection:'automatic',feeds}:{transport:'websocket',name:'Metadata',collection:'when-open',connection:{endpoint:'wss://fixture.example/metadata',auth:{mode:'none'},subscription:{body:{op:'subscribe'}},acknowledgement:{success:{path:['op'],equals:'ok'},failure:{path:['op'],equals:'error'}}},feeds};
  const repo=createSourceRepository(database),source=await repo.save(owner,config);
  await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);
  const peek=vi.fn(()=>{throw Error('Metadata must not use live payloads');});
  const chat=createDataSourceChat(database,peek,()=>[],()=>true),input={sourceId:source.id,revision:1,feedId:'metadata'};
  const listed=JSON.stringify(await chat.list(run));expect(listed).toContain('sentiment');expect(listed).toContain('maxAgeMs');expect(listed).not.toContain('private_score');
  expect(await chat.read(run,input)).toMatchObject({quality:'missing',fields:[{field:'score',quality:'missing',value:null},{field:'label',quality:'missing',value:null}]});
  const write=async(fields:Record<string,string|number>,time:number)=>{
   clock.mockReturnValue(time);
   expect(storage.enqueue(owner,{sourceId:source.id,feedId:'metadata',configVersion:1,schemaVersion:1,adapterId:transport==='http'?'custom-http':'custom-websocket',adapterVersion:'1',epoch:1,unit:'points',eventTime:time,receivedAt:time,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields}})).toBe(true);
   await storage.flush();
  };
  await write({score:62,label:'older',hidden:'not retained'},start);
  expect(await chat.read(run,input)).toMatchObject({quality:'fresh',origin:'stored-metadata',namespace:'sentiment',fields:[{field:'score',value:62,updatedAt:start,quality:'fresh'},{field:'label',value:'older',updatedAt:start,quality:'fresh'}]});
  await write({score:70},start+61000);
  expect(await chat.read(run,input)).toMatchObject({quality:'stale',fields:[{field:'score',value:70,updatedAt:start+61000,quality:'fresh'},{field:'label',value:'older',updatedAt:start,quality:'stale'}]});
  expect(JSON.stringify(await chat.read(run,input))).not.toContain('not retained');
  await db.query("UPDATE market_source_metadata SET field_timestamps='{}'");
  expect(await chat.read(run,input)).toMatchObject({quality:'stale',fields:[{updatedAt:null,quality:'stale'},{updatedAt:null,quality:'stale'}]});
  await repo.enable(owner,source.id,1,false);
  expect(await chat.read(run,input)).toMatchObject({quality:'disabled',value:null});
  await repo.save(owner,config,{id:source.id,revision:1});
  await expect(chat.read(run,input)).rejects.toThrow('changed');
  expect(peek).not.toHaveBeenCalled();
 }finally{await storage.close();clock.mockRestore();await db.close();}
});
