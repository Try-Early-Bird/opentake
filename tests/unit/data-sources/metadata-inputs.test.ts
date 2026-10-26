import {test,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createSourceRepository} from '../../../src/main/data-sources/repository';
import {createObservationStorage} from '../../../src/main/data-sources/storage';
import {createTakeInputs} from '../../../src/main/data-sources/take-inputs';
import {createRuleDrafts} from '../../../src/main/strategies/rule-drafts';
import {createRuleRunner} from '../../../src/main/strategies/rule-runner';
import {dataSourceThresholdPreset} from '../../../src/shared/strategy-rules';
import type {DataSnapshot} from '../../../src/shared/data-sources';

test.each(['http','websocket'] as const)('%s committed metadata drives sampled rules with field freshness and runtime continuity',async transport=>{
 const db=new PGlite();await migrate(db);const database={use:async<T>(work:(db:any)=>Promise<T>)=>work(db)};
 let now=Date.now(),runtimeId=randomUUID(),snapshot:DataSnapshot|null=null;
 const storage=createObservationStorage(database,{automatic:false,now:()=>now});
 const inputs=createTakeInputs(database,()=>[snapshot],()=>now),errors=vi.fn();
 const runner=createRuleRunner(database,inputs.snapshot,()=>{},()=>true,()=>now,errors);
 try{
  const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
  const take=randomUUID(),strategy=randomUUID(),version=randomUUID();
  await db.query('INSERT INTO strategies(id,owner_id) VALUES($1,$2)',[strategy,owner]);
  await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) VALUES($1,$2,$3,1,1,'{}','{}','{}','{}')",[version,strategy,owner]);
  await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
  await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) VALUES($1,$2,'Metadata fixture','{}',$3)",[take,owner,strategy]);
  const feeds=[{id:'metadata',name:'Score',unit:'points',mapping:{kind:'event',fields:{score:{path:['score'],type:'number'},label:{path:['label'],type:'string'},hidden:{path:['hidden'],type:'number'}}},storage:{mode:'latest',fields:['score','label']},destination:{kind:'market-metadata',market:{venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'},namespace:'sentiment',maxAgeMs:60000}}];
  const config=transport==='http'?{name:'Metadata',endpoint:'https://fixture.example/data',collection:'automatic',feeds}:{name:'Metadata',transport:'websocket',collection:'when-open',connection:{endpoint:'wss://fixture.example/data',auth:{mode:'none'},subscription:{body:{op:'subscribe'}},acknowledgement:{success:{path:['op'],equals:'ok'},failure:{path:['op'],equals:'error'}}},feeds};
  const repo=createSourceRepository(database),source=await repo.save(owner,config);await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);
  const binding={key:'score',sourceId:source.id,sourceRevision:1,feedId:'metadata',field:'score',kind:'event' as const,unit:'points',maxAgeMs:15000};
  const initial=await inputs.load(take);
  await expect(inputs.save({...initial,config:{inputs:[{...binding,field:'hidden'}],maxSkewMs:5000}})).rejects.toThrow('not retained');
  await inputs.save({...initial,config:{inputs:[binding],maxSkewMs:5000}});
  const drafts=createRuleDrafts(database,inputs.snapshot),base=dataSourceThresholdPreset(randomUUID(),'score','10',{kind:'notify',message:'Score below 10'});
  const rule={...base,trigger:{kind:'threshold' as const,input:'score',operator:'below' as const,value:'10'}};
  const draft=await drafts.save({...await drafts.load(take),config:{schemaVersion:1,rules:[rule]}});
  await expect(drafts.save({...draft,config:{schemaVersion:1,rules:[{...rule,trigger:{kind:'event',input:'score',eventIdField:'label',equals:1}}]}})).rejects.toThrow('sampled state');
  // Member acceptance (rule proposals) precedes enrollment; configure() enrolls only the accepted revision.
  await db.query('INSERT INTO strategy_rule_accepted(take_id,revision) VALUES($1,$2)',[take,draft.revision]);
  await runner.configure({takeId:take,draftRevision:draft.revision,enabled:true});
  const emit=(fields:Record<string,string|number>)=>{
   now+=1000;
   const observation={sourceId:source.id,configVersion:1,feedId:'metadata',schemaVersion:1,adapterId:transport==='http'?'custom-http':'custom-websocket',adapterVersion:'1',runtimeId,epoch:1,unit:'points',eventTime:now,receivedAt:now,timeBasis:'provider' as const,clockSkewMs:0,origin:'live' as const,payload:{kind:'event' as const,fields}};
   snapshot={quality:'fresh',connection:'live',issue:null,lastReceivedAt:now,latest:observation};
   expect(storage.enqueue(owner,observation)).toBe(true);
  };
  emit({score:20,label:'old'});
  expect((await inputs.snapshot(take)).status).toBe('blocked');
  await storage.flush();expect((await inputs.snapshot(take)).inputs[0]).toMatchObject({quality:'fresh',value:20});
  await runner.tick();
  emit({score:5});await runner.tick();
  expect((await db.query('SELECT id FROM strategy_rule_action_requests')).rows).toHaveLength(0);
  await storage.flush();await runner.tick();await runner.tick();
  const requests=(await db.query<{evidence:{snapshot:{inputs:Array<{value:number}>}}}>('SELECT evidence FROM strategy_rule_action_requests')).rows;
  expect(requests).toHaveLength(1);expect(requests[0].evidence.snapshot.inputs[0].value).toBe(5);
  const receipt=(await inputs.snapshot(take)).inputs[0].observation!.receivedAt;
  emit({label:'new'});await storage.flush();
  expect((await inputs.snapshot(take)).inputs[0]).toMatchObject({quality:'fresh',value:5,observation:{receivedAt:receipt}});
  now+=16000;emit({label:'still live'});await storage.flush();
  expect((await inputs.snapshot(take)).inputs[0].quality).toBe('stale');
  runtimeId=randomUUID();emit({label:'restart'});await storage.flush();
  expect((await inputs.snapshot(take)).inputs[0].quality).toBe('gap');
  emit({score:7});await storage.flush();expect((await inputs.snapshot(take)).inputs[0].quality).toBe('fresh');
  snapshot={...snapshot!,latest:{...snapshot!.latest!,epoch:2}};expect((await inputs.snapshot(take)).inputs[0].quality).toBe('gap');
  await db.query("UPDATE market_source_metadata SET field_timestamps='{}'");expect((await inputs.snapshot(take)).inputs[0].quality).toBe('missing');
  snapshot={...snapshot!,quality:'gap'};expect((await inputs.snapshot(take)).status).toBe('blocked');
  await repo.enable(owner,source.id,1,false);expect((await inputs.snapshot(take)).inputs[0].quality).toBe('disabled');
  expect(errors).not.toHaveBeenCalled();
 }finally{await runner.close();await storage.close();await db.close();}
});
