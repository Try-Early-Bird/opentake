import {test,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {strategyRule,ruleDraftConfig,dataSourceThresholdPreset} from '../../../src/shared/strategy-rules';
import {createRuleDrafts} from '../../../src/main/strategies/rule-drafts';
import {createTakeInputs} from '../../../src/main/data-sources/take-inputs';
const market={venue:'coinbase',instance:'production',kind:'crypto',reference:'BTC-USD'};
const agent={kind:'agent' as const,instructions:{format:'rules.md' as const,text:'Review the event and propose a trade if warranted.'},capabilities:{tools:['opentake_read_data_source'],accountIds:[randomUUID()],actions:['buy' as const],maxTradeNotionalUsd:'100'},budget:{maxDurationMs:60000,maxToolCalls:10,maxCostUsd:'1'}};
test('shared threshold preset supports trading and agent actions without granting execution',()=>{
 const base=dataSourceThresholdPreset(randomUUID(),'price','60000.000000000000000001',{kind:'buy',scope:{accountId:randomUUID()},market,amount:{kind:'notional',value:'100',currency:'USD'}});
 expect(base.trigger).toMatchObject({value:'60000.000000000000000001',operator:'crosses_below'});expect(base.policy.approval).toBe('ask');
 expect(strategyRule.parse({...base,action:agent}).action).toEqual(agent);
 for(const action of [{kind:'exit',scope:{accountId:randomUUID()},market},{kind:'trim',scope:{accountId:randomUUID()},market,toWeightBps:3000},{kind:'rebalance_to_target',scope:{accountId:randomUUID()}},{kind:'deploy_cash',scope:{accountId:randomUUID()},amount:{value:'50',currency:'USD'}},{kind:'pause_self'},{kind:'request_review',message:'Review'}])expect(strategyRule.safeParse({...base,action}).success).toBe(true);
 expect(strategyRule.safeParse({...base,enabled:true}).success).toBe(false);
 expect(strategyRule.safeParse({...base,action:{...agent,capabilities:{...agent.capabilities,accountIds:[]}}}).success).toBe(false);
 expect(strategyRule.safeParse({...base,action:{...agent,instructions:{path:'/tmp/rules.md'}}}).success).toBe(false);
 expect(strategyRule.safeParse({...base,action:{...agent,budget:{...agent.budget,maxToolCalls:0}}}).success).toBe(false);
 expect(strategyRule.safeParse({...base,trigger:{...base.trigger,resetValue:'59000'}}).success).toBe(false);
 expect(strategyRule.safeParse({...base,trigger:{...base.trigger,resetValue:'61000'}}).success).toBe(true);
 expect(strategyRule.safeParse({...base,trigger:{...base.trigger,resetValue:'not decimal'}}).success).toBe(false);
 expect(ruleDraftConfig.safeParse({schemaVersion:1,rules:[base,base]}).success).toBe(false);
});
test('rule drafts persist immutable instructions, reject stale references and remain inactive',async()=>{
 const db=new PGlite();await migrate(db);const database={use:async<T>(fn:(db:any)=>Promise<T>)=>fn(db)};
 const take=randomUUID(),strategy=randomUUID(),version=randomUUID(),source=randomUUID();
 const inputs=createTakeInputs(database,()=>[null]),snapshot=vi.fn(inputs.snapshot),drafts=createRuleDrafts(database,snapshot);
 try{
  await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
  await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners",[version,strategy]);
  await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
  await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Fixture','{}',$2 FROM local_owners",[take,strategy]);
  const config={name:'Signals',endpoint:'https://example.com/signals',collection:'automatic',pollIntervalMs:15000,feeds:[{id:'score',name:'Score',unit:'score',mapping:{kind:'metric',valuePath:['value']},storage:{mode:'live',fields:['value'],sampleEveryMs:60000,retentionDays:7}}]};
  await db.transaction(async tx=>{await tx.query('INSERT INTO data_sources(id,owner_id,current_revision,enabled,validated) SELECT $1,id,1,true,true FROM local_owners',[source]);await tx.query('INSERT INTO data_source_revisions(source_id,revision,config) VALUES($1,1,$2)',[source,JSON.stringify(config)]);});
  const initialInput=await inputs.load(take);const binding=await inputs.save({...initialInput,config:{inputs:[{key:'score',sourceId:source,sourceRevision:1,feedId:'score',field:'value',unit:'score',kind:'metric',maxAgeMs:15000}],maxSkewMs:5000}});
  const initial=await drafts.load(take),rule=dataSourceThresholdPreset(randomUUID(),'score','0.5',{...agent,capabilities:{tools:['opentake_read_data_source'],accountIds:[],actions:['request_review']}});
  const first=await drafts.save({...initial,config:{schemaVersion:1,rules:[rule]}});expect(first.revision).toBe(1);expect(snapshot).not.toHaveBeenCalled();
  expect((await drafts.load(take)).config.rules[0].action).toEqual(rule.action);
  const preview=await drafts.preview(take);expect(preview).toMatchObject({status:'draft_only',activationAvailable:false,actions:[{canExecute:false,kind:'agent'}]});expect(preview.blockers).toContain('rule_runner_not_enabled');expect(preview.blockers).toContain('inputs-unavailable');
  await expect(drafts.save({...initial,config:first.config})).rejects.toThrow('changed');
  await expect(drafts.save({...first,config:{schemaVersion:1,rules:[{...rule,trigger:{...rule.trigger,input:'missing'}}]}})).rejects.toThrow('not bound');
  await expect(drafts.save({...first,config:{schemaVersion:1,rules:[{...rule,action:agent}]}})).rejects.toThrow('account');
  const second=await drafts.save({...first,config:{schemaVersion:1,rules:[{...rule,name:'Edited draft'}]}});expect(second.revision).toBe(2);
  expect((await db.query('SELECT * FROM strategy_rule_draft_revisions')).rows).toHaveLength(2);
  await expect(db.query('UPDATE strategy_rule_draft_revisions SET config=config WHERE take_id=$1',[take])).rejects.toThrow();
  const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','rule-fixture' FROM local_owners RETURNING id")).rows[0].id;
  const account=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,'fixture','fixture') RETURNING id",[connection])).rows[0].id;
  const trading=await drafts.save({...second,config:{schemaVersion:1,rules:[{...rule,action:{kind:'buy',scope:{accountId:account},market,amount:{kind:'notional',value:'100',currency:'USD'}}}]}});
  expect((await drafts.preview(take)).actions).toEqual([{ruleId:rule.id,kind:'buy',approval:'ask',canExecute:false}]);
  await inputs.save(binding);expect((await drafts.preview(take)).blockers).toContain('input_revision_changed');await expect(drafts.save(trading)).rejects.toThrow('changed');
  const nextVersion=randomUUID();await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,2,1,'{}','{}','{}','{}' FROM local_owners",[nextVersion,strategy]);
  await db.query('UPDATE strategies SET current_version_id=$2 WHERE id=$1',[strategy,nextVersion]);expect((await drafts.preview(take)).blockers).toContain('strategy_version_changed');

  await db.query('UPDATE takes SET archived_at=now() WHERE id=$1',[take]);await expect(drafts.load(take)).rejects.toThrow('active Take');await expect(drafts.save(second)).rejects.toThrow('active Take');
  expect((await db.query('SELECT * FROM take_runs')).rows).toHaveLength(0);
 }finally{await db.close();}
});
