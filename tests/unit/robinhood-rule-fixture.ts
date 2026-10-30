// A rule's trade on a Robinhood Take over the real instructions, planner and executor, with a
// scripted fake broker (shared by the end-to-end and conformance tests). Synthetic
// profile only: no Robinhood connection or credentials.
import {afterEach} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createAccountSync} from '../../src/main/account-sync/service';
import {createAllocationCore} from '../../src/main/allocations/service';
import {createOrderWriter} from '../../src/main/orders/service';
import {createExecutor} from '../../src/main/execution/executor';
import {createPlanner} from '../../src/main/execution/planner';
import {createAllocationInstructions} from '../../src/main/execution/instructions';
import {createActionJobs} from '../../src/main/execution/action-jobs';
import {createVenueRegistry} from '../../src/main/venues/registry';
import {robinhoodVenueWith} from '../../src/main/venues/robinhood';
import {createRobinhoodRuleTrades} from '../../src/main/strategies/robinhood-rule-trades';
import {createRuleTradeApprovals,robinhoodRuleApprovals} from '../../src/main/strategies/rule-trade-approvals';
import {dataSourceThresholdPreset} from '../../src/shared/strategy-rules';
const dbs:PGlite[]=[];afterEach(async()=>{await Promise.all(dbs.splice(0).map(d=>d.close()));});
// Monday 2026-10-05: 11:00 Eastern is inside the regular session, 18:00 is not.
export const OPEN=Date.parse('2026-10-05T15:00:00Z'),CLOSED=Date.parse('2026-10-05T22:00:00Z');

export async function fixture(options:{approval?:'ask'|'within_existing_policy';closed?:boolean;deployUsd?:string}={}){
 const db=new PGlite();dbs.push(db);await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=options.closed?CLOSED:OPEN;const clock=()=>now;
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'500',cash:'500',buying_power:'500'}:name==='get_equity_quotes'?{results:[{symbol:'VTI',price:'250'}]}:{results:[]},
 },clock);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID(),take=randomUUID();
 const spec={schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
 await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,$3,$4,'{}','{}' FROM local_owners`,[version,strategy,JSON.stringify({title:'VTI'}),JSON.stringify(spec)]);
 await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
 await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'VTI Take','{}',$2 FROM local_owners",[take,strategy]);
 const invested=await createAllocationCore(database,clock).invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'100',cause:randomUUID()});
 const allocation=invested.allocationId;
 await db.query("UPDATE strategy_allocations SET status='active' WHERE id=$1",[allocation]);
 // The fake broker: every review and placement it receives. The next placement can be refused
 // (nothing placed) or lost (received, its answer never arrives).
 const calls:{stage:string;symbol:string;side:string}[]=[];let orders=0,next:'accept'|'reject'|'lost'='accept';
 const writer=createOrderWriter(database,{equityOrder:async(stage,input)=>{const o=input as {symbol:string;side:string};const mode=stage==='review'?'accept':next;if(stage==='place')next='accept';
  calls.push({stage:mode==='reject'?'refused':stage,symbol:o.symbol,side:o.side});
  if(mode==='reject')return {isError:true,errorCategory:'invalid_request',data:{}};
  if(mode==='lost')throw new Error('response lost');
  return stage==='review'?{review:'ok'}:{isError:false,errorCategory:null,data:{order:{id:`rh-${++orders}`}}};}},{enabled:()=>true},clock);
 // The rule's input (a crosses_below 10 trigger) as a live observation at the fixture's clock: still below.
 const sourceId=randomUUID();
 const snapshot=()=>({takeId:take,bindingRevision:1,acceptedVersion:version,capturedAt:now,status:'ready' as const,reason:null,inputs:[{binding:{key:'price',sourceId,sourceRevision:1,feedId:'price',field:'value',kind:'metric' as const,unit:'USD',maxAgeMs:15000},quality:'fresh' as const,value:'9',ageMs:0,
  observation:{sourceId,feedId:'price',configVersion:1,schemaVersion:1,epoch:1,runtimeId:'synthetic',unit:'USD',receivedAt:now,eventTime:null,timeBasis:'receipt',clockSkewMs:0,origin:'live',adapterId:'fixture',adapterVersion:'1',payload:{kind:'metric',value:9}}}]});
 const make=()=>{
  const executor=createExecutor(database,{orderWriter:writer,clock});
  const planner=createPlanner(database,{},clock);
  const instructions=createAllocationInstructions(database,{core:createAllocationCore(database,clock),planner,executor,clock} as never);
  const trades=createRobinhoodRuleTrades(database,{previewRebalance:(id,options)=>planner.previewAllocation(id,'manual',options),previewReduce:(id,amount)=>instructions.redemptionPreview(id,amount),
   rebalance:(id,options)=>instructions.plan(id,true,options),reduce:(id,amount,op)=>instructions.redeem(id,amount,op,true),tradingEnabled:()=>true,snapshot:async()=>snapshot() as never},clock);
  const venues=createVenueRegistry([robinhoodVenueWith(trades.adapters,{queue:trades,approvals:robinhoodRuleApprovals(trades)})]);
  const jobs=createActionJobs(database as never,venues,{clock});
  const approvals=createRuleTradeApprovals(venues,{cancel:async requestId=>{const job=(await db.query<{id:string}>("SELECT id FROM action_jobs WHERE idempotency_key='rule:'||$1::text",[requestId])).rows[0];await jobs.cancel(job.id);},nudge:()=>jobs.nudge()});
  // Jobs are stamped with the database's clock; this test runs on its own synthetic clock.
  return {trades,jobs,approvals,instructions,executor,tick:async()=>{await trades.enqueue();await db.query('UPDATE action_jobs SET next_run_at=$1 WHERE state IN (\'queued\',\'running\',\'waiting\')',[new Date(now).toISOString()]);await jobs.tick();}};
 };
 let app=make();
 // An accepted rebalance rule on this Take's Robinhood account, granted trading.
 const base=dataSourceThresholdPreset(randomUUID(),'price','10',options.deployUsd?{kind:'deploy_cash',scope:{accountId:account},amount:{value:options.deployUsd,currency:'USD'}}:{kind:'rebalance_to_target',scope:{accountId:account}});
 const rule={...base,name:'Rebalance VTI',policy:{...base.policy,approval:options.approval??'ask'}};
 await db.query("INSERT INTO take_input_revisions(take_id,revision,accepted_version,config) VALUES($1,1,$2,'{\"inputs\":[],\"maxSkewMs\":5000}')",[take,version]);
 await db.query('INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) VALUES($1,1,$2,1,$3)',[take,version,JSON.stringify({schemaVersion:1,rules:[rule]})]);
 await db.query('INSERT INTO strategy_rule_accepted(take_id,revision,trading_enabled,trading_rule_ids) VALUES($1,1,true,$2)',[take,[rule.id]]);
 await db.query('INSERT INTO strategy_rule_shadow(take_id,draft_revision,enabled,notifications_enabled) VALUES($1,1,true,true)',[take]);
 const fire=async(key=randomUUID())=>{const id=randomUUID();await db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,1,$3,$4,now(),now()+interval '1 hour','shadow',$5,$6) ON CONFLICT DO NOTHING`,[id,take,rule.id,key,JSON.stringify(rule.action),JSON.stringify({rule,snapshot:snapshot()})]);return id;};
 const placed=()=>calls.filter(c=>c.stage==='place');
 const job=async(requestId:string)=>(await db.query<{state:string;waiting_for:string|null;reason:string|null}>("SELECT state,waiting_for,reason FROM action_jobs WHERE origin_id=$1",[requestId])).rows[0];
 const request=async(id:string)=>(await db.query<{status:string}>('SELECT status FROM strategy_rule_action_requests WHERE id=$1',[id])).rows[0].status;
 const fillAll=()=>db.query("UPDATE strategy_executions SET status='filled',terminal_at=now() WHERE status IN ('submitted','reviewed','submitting')");
 return {db,take,allocation,account,nextPlacement:(mode:typeof next)=>{next=mode;},app:()=>app,restart:()=>{app=make();return app;},fire,placed,job,request,fillAll,setNow:(t:number)=>{now=t;},strategy,version};
}
