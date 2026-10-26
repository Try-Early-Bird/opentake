import {test,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createTakeInputs,evaluateTakeInput} from '../../../src/main/data-sources/take-inputs';
import type {DataSnapshot} from '../../../src/shared/data-sources';
import type {TakeInput} from '../../../src/shared/take-inputs';
const now=Date.now(),sourceId=randomUUID();
const config={name:'Fixture sentiment',endpoint:'https://fixture.example/data',collection:'automatic',pollIntervalMs:60000,feeds:[{id:'score',name:'Score',unit:'score',mapping:{kind:'metric',valuePath:['score']},storage:{mode:'latest',fields:['value'],sampleEveryMs:60000,retentionDays:7}}]};
const binding:TakeInput={key:'sentiment',sourceId,sourceRevision:1,feedId:'score',field:'value',kind:'metric',unit:'score',maxAgeMs:15000};
const source={id:sourceId,current_revision:1,enabled:true,validated:true,config};
const sample:DataSnapshot={connection:'live',quality:'fresh',issue:null,lastReceivedAt:now,latest:{sourceId,feedId:'score',configVersion:1,schemaVersion:1,adapterId:'fixture',adapterVersion:'1',epoch:1,unit:'score',eventTime:now,receivedAt:now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'metric',value:'0.750000000000000001'}}};
test('input snapshots reject stale, changed, disabled, wrong-unit and backfilled evidence',()=>{
 expect(evaluateTakeInput(binding,source,sample,now)).toMatchObject({quality:'fresh',value:'0.750000000000000001',ageMs:0});
 expect(evaluateTakeInput(binding,source,sample,now+15001).quality).toBe('stale');
 expect(evaluateTakeInput(binding,{...source,current_revision:2},sample,now).quality).toBe('source-changed');
 expect(evaluateTakeInput(binding,{...source,enabled:false},sample,now).quality).toBe('disabled');
 expect(evaluateTakeInput(binding,source,{...sample,latest:{...sample.latest!,unit:'USD'}},now).quality).toBe('invalid');
 expect(evaluateTakeInput(binding,source,{...sample,latest:{...sample.latest!,origin:'backfill'}},now).quality).toBe('stale');
 expect(evaluateTakeInput(binding,source,{...sample,quality:'gap'},now).quality).toBe('gap');
 expect(evaluateTakeInput(binding,source,null,now).quality).toBe('missing');
});
test('bindings are revisioned, Take-owned, version-pinned and captured coherently without acquisition',async()=>{
 const db=new PGlite();await migrate(db);const take=randomUUID(),strategy=randomUUID(),version=randomUUID(),second=randomUUID();
 const database={use:async<T>(fn:(db:any)=>Promise<T>)=>fn(db)},peek=vi.fn(()=>[structuredClone(sample)]);
 const service=createTakeInputs(database,peek,()=>now);
 try{
  await db.query("INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners",[strategy]);
  await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners",[version,strategy]);
  await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
  await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Fixture','{}',$2 FROM local_owners",[take,strategy]);
  await db.transaction(async tx=>{await tx.query('INSERT INTO data_sources(id,owner_id,current_revision,enabled,validated) SELECT $1,id,1,true,true FROM local_owners',[sourceId]);await tx.query('INSERT INTO data_source_revisions(source_id,revision,config) VALUES($1,1,$2)',[sourceId,JSON.stringify(config)]);});
  const initial=await service.load(take);expect(initial.revision).toBe(0);
  expect((await service.snapshot(take)).reason).toBe('no-inputs');
  const saved=await service.save({...initial,config:{inputs:[binding],maxSkewMs:5000}});expect(saved.revision).toBe(1);
  await expect(service.save({...initial,config:{inputs:[binding],maxSkewMs:5000}})).rejects.toThrow('changed');
  expect(await service.snapshot(take)).toMatchObject({status:'ready',bindingRevision:1,acceptedVersion:version,inputs:[{value:'0.750000000000000001'}]});
  const nextBinding={...binding,key:'other'};
  const two=await service.save({...saved,config:{inputs:[binding,nextBinding],maxSkewMs:5000}});
  peek.mockImplementation(()=>[structuredClone(sample),{...sample,latest:{...sample.latest!,eventTime:now-6000}}]);
  expect((await service.snapshot(take)).reason).toBe('time-skew');
  await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,2,1,'{}','{}','{}','{}' FROM local_owners",[second,strategy]);
  await db.query('UPDATE strategies SET current_version_id=$2 WHERE id=$1',[strategy,second]);
  expect((await service.snapshot(take)).inputs[0].quality).toBe('version-changed');
  await expect(service.save(two)).rejects.toThrow('changed');
  await expect(service.load(randomUUID())).rejects.toThrow('active Take');
  await expect(db.query('UPDATE take_input_revisions SET config=config WHERE take_id=$1',[take])).rejects.toThrow();
  await db.query('UPDATE takes SET archived_at=now() WHERE id=$1',[take]);await expect(service.snapshot(take)).rejects.toThrow('active Take');
 }finally{await db.close();}
});

test('host snapshot peeks do not acquire sources or create polling work',async()=>{
 const {createDataSourceHostService}=await import('../../../src/main/data-sources/host-service');
 const poll=vi.fn(async()=>{}),host=createDataSourceHostService([{id:'fixture',version:'1',transport:'http',kinds:['metric'],history:false,replay:false,poll}], [{ownerId:'owner',sourceId,configVersion:1,adapterId:'fixture',authScope:'public',feedId:'score',schemaVersion:1,parameters:{},kind:'metric',unit:'score',semantics:'state',ordering:'arrival',freshnessMs:15000,pollIntervalMs:60000}]);
 try{expect(host.peek([{sourceId,feedId:'score',configVersion:1,schemaVersion:1}])).toEqual([null]);expect(poll).not.toHaveBeenCalled();}finally{host.close();}
});
