// A rule's rebalance or reduce on a Robinhood Take. Synthetic planner and
// executor; no Robinhood connection or credentials.
import {afterEach,expect,test,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createRobinhoodRuleTrades,type RobinhoodRuleTradeDeps} from '../../src/main/strategies/robinhood-rule-trades';
import {dataSourceThresholdPreset} from '../../src/shared/strategy-rules';
const dbs:PGlite[]=[];afterEach(async()=>{await Promise.all(dbs.splice(0).map(d=>d.close()));});

async function fixture(options:{approval?:'ask'|'within_existing_policy';action?:'rebalance'|'deploy'|'reduce';off?:boolean;agent?:{actions:string[];ceiling:string;request?:'reduce'|'rebalance_to_target';suspicious?:boolean}}={}){
 const db=new PGlite();dbs.push(db);await migrate(db);const database={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const strategy=randomUUID(),version=randomUUID(),take=randomUUID(),allocation=randomUUID();
 await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners`,[version,strategy]);
 await db.query("UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1",[strategy,version]);
 await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Fixture','{}',$2 FROM local_owners",[take,strategy]);
 await db.query("INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,created_at,updated_at) VALUES($1,$2,$3,$4,'USD','active',now(),now())",[allocation,account,strategy,version]);
 const agentAction=options.agent?{kind:'agent',instructions:{format:'prompt',text:'Decide.'},capabilities:{tools:[],accountIds:[account],actions:options.agent.actions,maxTradeNotionalUsd:options.agent.ceiling},budget:{}}:null;
 const base=dataSourceThresholdPreset(randomUUID(),'price','10',(agentAction??(options.action==='reduce'?{kind:'reduce',scope:{accountId:account},amount:{value:'25',currency:'USD'}}:options.action==='deploy'?{kind:'deploy_cash',scope:{accountId:account},amount:{value:'25',currency:'USD'}}:{kind:'rebalance_to_target',scope:{accountId:account}})) as never);
 const rule={...base,name:'BTC drop',policy:{...base.policy,approval:options.approval??'ask'}};
 await db.query("INSERT INTO take_input_revisions(take_id,revision,accepted_version,config) VALUES($1,1,$2,'{\"inputs\":[],\"maxSkewMs\":5000}')",[take,version]);
 await db.query('INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) VALUES($1,1,$2,1,$3)',[take,version,JSON.stringify({schemaVersion:1,rules:[rule]})]);
 await db.query('INSERT INTO strategy_rule_accepted(take_id,revision,trading_enabled,trading_rule_ids,disabled_rule_ids) VALUES($1,1,true,$2,$3)',[take,[rule.id],options.off?[rule.id]:[]]);
 await db.query('INSERT INTO strategy_rule_shadow(take_id,draft_revision,enabled,notifications_enabled) VALUES($1,1,true,true)',[take]);
 // The rule's input as the firing saw it, and as a re-check sees it now (a crosses_below 10 trigger).
 let nowMs=Date.now(),price='9',quality:'fresh'|'stale'='fresh';const sourceId=randomUUID();
 const input=(value:string)=>({binding:{key:'price',sourceId,sourceRevision:1,feedId:'price',field:'value',kind:'metric' as const,unit:'USD',maxAgeMs:15000},quality,value,ageMs:0,
  observation:{sourceId,feedId:'price',configVersion:1,schemaVersion:1,epoch:1,runtimeId:'synthetic',unit:'USD',receivedAt:nowMs,eventTime:null,timeBasis:'receipt',clockSkewMs:0,origin:'live',adapterId:'fixture',adapterVersion:'1',payload:{kind:'metric',value:Number(value)}}});
 const snapshot=()=>({takeId:take,bindingRevision:1,acceptedVersion:version,capturedAt:nowMs,status:quality==='fresh'?'ready' as const:'blocked' as const,reason:quality==='fresh'?null:'inputs-unavailable' as const,inputs:[input(price)]});
 const request=randomUUID();
 await db.query(`INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,1,$3,'k',now(),now()+interval '1 hour','shadow',$4,$5)`,[request,take,rule.id,JSON.stringify(agentAction?(options.agent?.request==='rebalance_to_target'?{kind:'rebalance_to_target',scope:{accountId:account}}:{kind:'reduce',scope:{accountId:account},amount:{value:'25',currency:'USD'}}):rule.action),JSON.stringify({rule,snapshot:snapshot(),...(agentAction?{agent:{parentRequestId:randomUUID(),runId:randomUUID(),reason:'Raise cash',...(options.agent?.suspicious?{suspicion:{sources:['a data source'],signals:['instruction_override']}}:{})}}:{})})]);
 let seq=0;
 const leg=async(transactionId:string,status:string)=>{const id=randomUUID();
  await db.query(`INSERT INTO strategy_allocation_transactions(id,allocation_id,sequence,kind,trigger,idempotency_key,request_hash,created_at) VALUES($1,$2,$3,'rebalance','manual',$4,'h',now())`,[transactionId,allocation,++seq,randomUUID()]);
  await db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,transaction_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,created_at,updated_at)
  VALUES($1,$2,$3,$4,$5,'rebalance','VTI','buy',$6,'{}',$7,$8,now(),now())`,[id,allocation,account,strategy,transactionId,status,randomUUID(),createHash('sha256').update(id).digest('hex')]);return id;};
 const placed:string[]=[];let reducePreview={ok:true,legs:[{symbol:'VTI',notional:'25.00'}],reasons:[] as {code:string}[]};
 const notify=vi.fn(async()=>{});
 const planOptions:unknown[]=[];let rebalanceReason:string|null=null;
 type Sleeves=Awaited<ReturnType<RobinhoodRuleTradeDeps['previewRebalance']>>['sleeves'];
 let sleeves:Sleeves=[{symbol:'VTI',disposition:'order',side:'buy',amount:'40.00',notionalUsd:'40.00'},{symbol:'BND',disposition:'skip',side:null,amount:null,notionalUsd:null}];
 const deps:RobinhoodRuleTradeDeps={
  previewRebalance:async(_id,options)=>(planOptions.push(options),{disposition:'planned',reasonCode:null,sleeves}),
  previewReduce:async()=>reducePreview,
  rebalance:async(_id,options)=>{planOptions.push(options);if(rebalanceReason)return {planId:null,disposition:'deferred',reasonCode:rebalanceReason};const id=randomUUID();placed.push(id);await leg(id,'submitted');return {planId:id,disposition:'planned',reasonCode:null};},
  reduce:async(_a,_amount,op)=>{const id=randomUUID();placed.push(id);await leg(id,'submitted');expect(op).toBe(request);return {disposition:'planned',reasonCode:null,instruction:{id}};},
  tradingEnabled:()=>true,notify,snapshot:async()=>snapshot() as never};
 const trades=createRobinhoodRuleTrades(database,deps,()=>nowMs);
 const status=async()=>(await db.query<{status:string}>('SELECT status FROM strategy_rule_action_requests WHERE id=$1',[request])).rows[0].status;
 const fill=()=>db.query("UPDATE strategy_executions SET status='filled'");
 return {db,trades,request,take,placed,notify,status,fill,planOptions,setReducePreview:(v:typeof reducePreview)=>{reducePreview=v;},
  setSleeves:(v:Sleeves)=>{sleeves=v;},advance:(ms:number)=>{nowMs+=ms;},setPrice:(v:string)=>{price=v;},setQuality:(v:'fresh'|'stale')=>{quality=v;},refuseRebalance:(reason:string)=>{rebalanceReason=reason;}};
}

test('a rule that asks first waits with its previewed orders; approving places them once, confirmed, and follows them to filled',async()=>{
 const f=await fixture();
 expect(await f.trades.enqueue()).toEqual({created:1});expect((await f.db.query("SELECT venue,kind FROM action_jobs")).rows).toEqual([{venue:'robinhood',kind:'rebalance_to_target'}]);
 expect(await f.trades.step(f.request)).toMatchObject({state:'waiting',waitingFor:'approval'});
 expect(await f.trades.pending(f.take)).toEqual([expect.objectContaining({request_id:f.request,kind:'rebalance_to_target',rule_name:'BTC drop',preview:expect.objectContaining({orders:[{symbol:'VTI',side:'buy',amountUsd:'40.00'}]})})]);
 expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({title:'Rule “BTC drop” wants to trade',attention:true}));
 expect(await f.trades.step(f.request)).toMatchObject({state:'waiting',waitingFor:'approval'});expect(f.placed).toHaveLength(0);
 await f.trades.decide(f.request,true);
 expect(await f.trades.step(f.request)).toMatchObject({state:'running'});expect(f.placed).toHaveLength(1);
 expect(await f.trades.step(f.request)).toMatchObject({state:'running'});expect(f.placed).toHaveLength(1);
 await f.fill();expect(await f.trades.step(f.request)).toEqual({state:'succeeded',reason:'filled'});expect(await f.status()).toBe('executed');
 expect(await f.trades.pending(f.take)).toEqual([]);
});

test('without approval it places at once; declining instead places nothing; an off rule never trades',async()=>{
 const direct=await fixture({approval:'within_existing_policy'});
 expect(await direct.trades.step(direct.request)).toMatchObject({state:'running'});expect(direct.placed).toHaveLength(1);
 const declined=await fixture();await declined.trades.step(declined.request);await declined.trades.decide(declined.request,false);
 expect(await declined.trades.step(declined.request)).toMatchObject({state:'cancelled',reason:'member_declined'});expect(declined.placed).toHaveLength(0);expect(await declined.status()).toBe('action_blocked');
 await expect(declined.trades.decide(declined.request,true)).rejects.toThrow('no longer waiting');
 const off=await fixture({off:true});expect(await off.trades.step(off.request)).toEqual({state:'blocked',reason:'rule_off'});expect(off.placed).toHaveLength(0);
});

test('a reduce previews its sells, withdraws with the firing as its operation, and is refused outside the withdrawal band',async()=>{
 const f=await fixture({action:'reduce',approval:'within_existing_policy'});
 expect(await f.trades.step(f.request)).toMatchObject({state:'running'});expect(f.placed).toHaveLength(1);
 const refused=await fixture({action:'reduce'});refused.setReducePreview({ok:false,legs:[],reasons:[{code:'above_band'}]});
 expect(await refused.trades.step(refused.request)).toEqual({state:'blocked',reason:'above_band'});expect(await refused.status()).toBe('action_blocked');
});

test('an agent run\'s reduce on Robinhood stays within its rule\'s actions, account and per-trade ceiling',async()=>{
 const within=await fixture({agent:{actions:['reduce'],ceiling:'50'}});
 expect(await within.trades.step(within.request)).toMatchObject({state:'waiting',waitingFor:'approval'});
 expect(await within.trades.pending(within.take)).toEqual([expect.objectContaining({kind:'reduce',amount:'25'})]);
 const over=await fixture({agent:{actions:['reduce'],ceiling:'10'}});
 expect(await over.trades.step(over.request)).toEqual({state:'blocked',reason:'agent_notional_ceiling'});expect(over.placed).toHaveLength(0);
 const outside=await fixture({agent:{actions:['rebalance_to_target'],ceiling:'50'}});
 expect(await outside.trades.step(outside.request)).toEqual({state:'blocked',reason:'agent_outside_ceiling'});
});

test('deploy cash plans buy-only with its amount as the cash cap, in the preview and when placing',async()=>{
 const f=await fixture({action:'deploy',approval:'within_existing_policy'});
 expect(await f.trades.step(f.request)).toMatchObject({state:'running'});expect(f.placed).toHaveLength(1);
 // Preview, the fresh check before placing, then the placing plan itself.
 expect(f.planOptions).toEqual([{buysOnly:true,cashCapUsd:'25'},{buysOnly:true,cashCapUsd:'25'},{buysOnly:true,cashCapUsd:'25'}]);
 const rebalance=await fixture({approval:'within_existing_policy'});await rebalance.trades.step(rebalance.request);
 expect(rebalance.planOptions).toEqual([undefined,undefined,{}]);
});

test('an agent rebalance counts sells at their USD value against its ceiling, not their share count',async()=>{
 const f=await fixture({agent:{actions:['rebalance_to_target'],ceiling:'100',request:'rebalance_to_target'}});
 // 3 shares worth $540: the share count must not pass a $100 ceiling.
 f.setSleeves([{symbol:'NVDA',disposition:'order',side:'sell',amount:'3',notionalUsd:'540.00'}]);
 expect(await f.trades.step(f.request)).toEqual({state:'blocked',reason:'agent_notional_ceiling'});expect(f.placed).toHaveLength(0);
 const unknown=await fixture({agent:{actions:['rebalance_to_target'],ceiling:'100',request:'rebalance_to_target'}});
 unknown.setSleeves([{symbol:'NVDA',disposition:'order',side:'sell',amount:'3'}]);
 expect(await unknown.trades.step(unknown.request)).toEqual({state:'blocked',reason:'agent_notional_ceiling'});
 const within=await fixture({agent:{actions:['rebalance_to_target'],ceiling:'600',request:'rebalance_to_target'}});
 within.setSleeves([{symbol:'NVDA',disposition:'order',side:'sell',amount:'3',notionalUsd:'540.00'}]);
 expect(await within.trades.step(within.request)).toMatchObject({state:'waiting',waitingFor:'approval'});
 expect((await within.trades.pending(within.take))[0].preview.orders).toEqual([{symbol:'NVDA',side:'sell',amountUsd:'540.00'}]);
});

test('approving later trades only if the rule\'s trigger still holds; stale inputs wait, a passed reason blocks',async()=>{
 const f=await fixture();await f.trades.step(f.request);
 f.advance(3*24*60*60_000);await f.trades.decide(f.request,true);
 f.setQuality('stale');expect(await f.trades.step(f.request)).toMatchObject({state:'waiting',waitingFor:'inputs'});expect(f.placed).toHaveLength(0);
 f.setQuality('fresh');f.setPrice('11');
 expect(await f.trades.step(f.request)).toEqual({state:'blocked',reason:'conditions_no_longer_hold'});expect(f.placed).toHaveLength(0);
 const holds=await fixture();await holds.trades.step(holds.request);holds.advance(3*24*60*60_000);await holds.trades.decide(holds.request,true);
 expect(await holds.trades.step(holds.request)).toMatchObject({state:'running'});expect(holds.placed).toHaveLength(1);
});

test('orders that grew since approval are put back to the member; the placing plan is capped at what was approved',async()=>{
 const f=await fixture();await f.trades.step(f.request);await f.trades.decide(f.request,true);
 f.setSleeves([{symbol:'VTI',disposition:'order',side:'buy',amount:'400.00',notionalUsd:'400.00'}]);
 expect(await f.trades.step(f.request)).toMatchObject({state:'waiting',waitingFor:'approval'});expect(f.placed).toHaveLength(0);
 expect(f.notify).toHaveBeenLastCalledWith(expect.objectContaining({title:'Rule “BTC drop” trade changed'}));
 expect((await f.trades.pending(f.take))[0].preview.orders).toEqual([{symbol:'VTI',side:'buy',amountUsd:'400.00'}]);
 await f.trades.decide(f.request,true);
 expect(await f.trades.step(f.request)).toMatchObject({state:'running'});expect(f.placed).toHaveLength(1);
 expect(f.planOptions.at(-1)).toEqual({maxNotionalUsd:'441'});
 // A new symbol is never inside the approval, and a planner refusal at the cap places nothing.
 const added=await fixture();await added.trades.step(added.request);await added.trades.decide(added.request,true);
 added.setSleeves([{symbol:'VTI',disposition:'order',side:'buy',amount:'40.00',notionalUsd:'40.00'},{symbol:'QQQ',disposition:'order',side:'buy',amount:'5.00',notionalUsd:'5.00'}]);
 expect(await added.trades.step(added.request)).toMatchObject({state:'waiting',waitingFor:'approval'});
 const capped=await fixture();await capped.trades.step(capped.request);await capped.trades.decide(capped.request,true);capped.refuseRebalance('notional_cap');
 expect(await capped.trades.step(capped.request)).toEqual({state:'blocked',reason:'notional_cap'});expect(capped.placed).toHaveLength(0);
});

test('prompt-injection guard: an agent trade from a run flagged as reading instructions waits for approval even when the rule needs none',async()=>{
 const clean=await fixture({approval:'within_existing_policy',agent:{actions:['reduce'],ceiling:'50'}});
 expect(await clean.trades.step(clean.request)).toMatchObject({state:'running'});expect(clean.placed).toHaveLength(1);
 const flagged=await fixture({approval:'within_existing_policy',agent:{actions:['reduce'],ceiling:'50',suspicious:true}});
 expect(await flagged.trades.step(flagged.request)).toMatchObject({state:'waiting',waitingFor:'approval'});expect(flagged.placed).toHaveLength(0);
});
