// A trim rule suggests a new target; synthetic data only.
import {afterEach,expect,test,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createStrategies} from '../../src/main/strategies/service';
import {createTakes} from '../../src/main/takes';
import {createRuleTargetSuggestions} from '../../src/main/strategies/rule-target-suggestions';
import {dataSourceThresholdPreset} from '../../src/shared/strategy-rules';
import type {Verification} from '../../src/shared/strategies';
const dbs:PGlite[]=[];afterEach(async()=>{await Promise.all(dbs.splice(0).map(d=>d.close()));});
const verification:Verification={policy:'personal_basket',version:1,checkedAt:'2026-10-02T00:00:00Z',accountRef:null,results:[]};
const account='11111111-1111-4111-8111-111111111111';
const btc={venue:'coinbase',instance:'production',kind:'crypto',reference:'BTC-USD'};

async function fixture(rules:(r:ReturnType<typeof dataSourceThresholdPreset>)=>unknown[]){
 const db=new PGlite();dbs.push(db);await migrate(db);const database={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const strategies=createStrategies(database,{active:()=>false,ensure:async()=>{},verify:async()=>structuredClone(verification)});
 const takes=createTakes(database,async()=>{},async()=>({ok:true,source:'runtime',models:[]}));
 const take=await takes.create();
 const proposed=await strategies.propose({targetTakeId:take,expectedRevision:null,expectedVersion:null,operationId:randomUUID(),metadata:{title:'BTC 60/40',description:'',rationale:'Fixture',holdings:[]},
  spec:{schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:6000}],cashBps:4000},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:[]});
 if(!proposed.ok)throw Error('propose');const committed=await strategies.commit({targetTakeId:take,expectedRevision:proposed.view.draft.id,expectedVersion:null,operationId:randomUUID()});
 if(!committed.ok)throw Error('commit');const version=committed.committedVersion!;
 const base=dataSourceThresholdPreset(randomUUID(),'btc','80000',{kind:'notify',message:'x'});
 const config={schemaVersion:1,rules:rules(base)};
 await db.query("INSERT INTO take_input_revisions(take_id,revision,accepted_version,config) VALUES($1,1,$2,'{\"inputs\":[],\"maxSkewMs\":5000}')",[take,version]);
 await db.query('INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) VALUES($1,1,$2,1,$3)',[take,version,JSON.stringify(config)]);
 await db.query('INSERT INTO strategy_rule_accepted(take_id,revision,trading_enabled,trading_rule_ids) VALUES($1,1,false,$2)',[take,[]]);
 await db.query('INSERT INTO strategy_rule_shadow(take_id,draft_revision,enabled,notifications_enabled) VALUES($1,1,true,true)',[take]);
 const fire=async(rule:{id:string;action:unknown})=>{const id=randomUUID();await db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,1,$3,$4,now(),now()+interval '1 hour','shadow',$5,'{}')`,[id,take,rule.id,randomUUID(),JSON.stringify(rule.action)]);return id;};
 const notify=vi.fn(async()=>{});
 const worker=createRuleTargetSuggestions(database,{suggest:input=>strategies.ruleSuggest(input),value:async()=>100,notify});
 const status=async(id:string)=>(await db.query<{status:string;evidence:{target?:Record<string,unknown>}}>('SELECT status,evidence FROM strategy_rule_action_requests WHERE id=$1',[id])).rows[0];
 return {db,strategies,take,fire,worker,notify,status,draftId:committed.view.draft.id};
}

test('a trim rule suggests the new target with what will keep it there; the draft is untouched and nothing trades',async()=>{
 const trim={id:randomUUID(),name:'Trim BTC',action:{kind:'trim',scope:{accountId:account},market:btc,toWeightBps:3000}};
 const f=await fixture(base=>[{...base,...trim},{...base,id:randomUUID(),name:'Rebalance to 60/40',action:{kind:'rebalance_to_target',scope:{accountId:account}}}]);
 const id=await f.fire(trim);await f.worker.pass();
 expect(await f.status(id)).toMatchObject({status:'executed',evidence:{target:{summary:'BTC 60% → 30% (to cash)'}}});
 const view=(await f.strategies.read(f.take))!;
 expect(view.draft.id).toBe(f.draftId);
 expect(view.suggestions).toEqual([expect.objectContaining({ruleName:'Trim BTC',note:'Once committed, rule “Rebalance to 60/40” will keep the Take at the new target.'})]);
 const suggestion=view.proposals.find(p=>p.id===view.suggestions![0].proposalId)!;
 expect(suggestion.spec.target).toEqual({weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:3000}],cashBps:7000});
 expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({title:'Rule “Trim BTC” suggested a new target',attention:false}));
 await f.worker.pass();expect((await f.strategies.read(f.take))!.suggestions).toHaveLength(1);
});

test('without rebalancing the note says so; a buy beyond the target cash is refused with a reason',async()=>{
 const exit={id:randomUUID(),name:'Trim BTC',action:{kind:'trim',scope:{accountId:account},market:btc,toWeightBps:1000}};
 const buy={id:randomUUID(),name:'Buy BTC',action:{kind:'buy',scope:{accountId:account},market:btc,amount:{kind:'notional',value:'50',currency:'USD'}}};
 const f=await fixture(base=>[{...base,...exit},{...base,...buy}]);
 await f.fire(exit);await f.worker.pass();
 expect((await f.strategies.read(f.take))!.suggestions![0].note).toContain('does not rebalance by itself');
 const refused=await f.fire(buy);await f.worker.pass();
 expect(await f.status(refused)).toMatchObject({status:'action_blocked',evidence:{target:{reason:'not_enough_cash'}}});
 expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({title:'Rule “Buy BTC” could not suggest a change',attention:true}));
});
