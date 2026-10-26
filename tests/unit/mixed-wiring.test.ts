import {test,expect,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../src/main/migrations';
import {createMixedInvestments} from '../../src/main/mixed-execution/service';
import {createAccountSync} from '../../src/main/account-sync/service';
import {createTakeAccountPlans} from '../../src/main/strategies/account-plans';
import {createStrategies} from '../../src/main/strategies/service';
import {createTakes} from '../../src/main/takes';
import {createPlanner} from '../../src/main/execution/planner';
import {executionBasket} from '../../src/main/mixed-execution/basket';
import type {CoinbaseOrderReview} from '../../src/shared/coinbase-orders';
const databases:PGlite[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.close();});
async function fixture(closed=false,driftBandPoints:number|null=null){
 const db=new PGlite();databases.push(db);await migrate(db);
 let now=Date.parse(closed?'2026-10-13T23:00:00Z':'2026-10-13T15:00:00Z');
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const accounts:Record<string,string>={};
 for(const venue of ['coinbase','robinhood']){
  const c=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,$1,'connected',$1 FROM local_owners RETURNING id",[venue])).rows[0].id;
  accounts[venue]=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,available,agentic_allowed,selected) VALUES($1,'synthetic','Synthetic',true,true,$2) RETURNING id",[c,venue==='robinhood'])).rows[0].id;
  if(venue==='coinbase')await db.query("INSERT INTO coinbase_connection_details(connection_id,label,portfolio_name,can_trade) VALUES($1,'Synthetic','Synthetic',true)",[c]);
 }
 let rhCash='100',buyingPower:string|null=null;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:accounts.robinhood,maskedNumber:'Synthetic',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:rhCash,cash:rhCash,buying_power:buyingPower??rhCash}:name==='get_equity_quotes'?{results:[{symbol:'AAPL',price:'100'}]}:{results:[]},
 },()=>now);
 const refresh=async()=>{
  await sync.synchronize();
  await db.query("INSERT INTO coinbase_transaction_history(account_id,checked_at,state,data) VALUES($1,$2,'complete',$3) ON CONFLICT(account_id) DO UPDATE SET checked_at=excluded.checked_at,data=excluded.data",[accounts.coinbase,new Date(now).toISOString(),JSON.stringify({state:'complete',wallets:[{wallet:'usdc',asset:'USDC',balance:'100',available:'100',held:'0'}]})]);
 };
 const takes=createTakes(database,async()=>{},async()=>({ok:true,source:'runtime',models:[]}));
 const strategies=createStrategies(database,{active:()=>false,ensure:async()=>{},verify:async()=>({policy:'personal_basket',version:1,checkedAt:new Date(now).toISOString(),accountRef:null,results:[]})});
 const takeId=await takes.create();
 const spec={schemaVersion:1 as const,kind:'basket' as const,target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:4000},{instrument:{venue:'coinbase',symbol:'ZEC'},bps:3000},{instrument:{venue:'robinhood',symbol:'AAPL'},bps:3000}],cashBps:0},rebalance:{schedule:'never' as const,driftBandPoints,driftBandRelative:null}};
 const p=await strategies.propose({targetTakeId:takeId,expectedRevision:null,expectedVersion:null,operationId:randomUUID(),metadata:{title:'Mixed fixture',description:'',rationale:'',holdings:[]},spec,unsupportedRequests:[]});if(!p.ok)throw Error(p.message);
 const committed=await strategies.commit({targetTakeId:takeId,expectedRevision:p.view.draft.id,expectedVersion:null,operationId:randomUUID()});if(!committed.ok)throw Error(committed.message);
 const plans=createTakeAccountPlans(database),plan=await plans.read(takeId);await plans.save({takeId,draftRevision:plan.draftRevision,revision:plan.revision,routes:[{venue:'coinbase',accountId:accounts.coinbase},{venue:'robinhood',accountId:accounts.robinhood}]});
 const cbPreview=vi.fn(async():Promise<CoinbaseOrderReview>=>({id:randomUUID(),takeId,accountLabel:'Synthetic',takeTitle:'Mixed fixture',quote:'USDC',phase:'buy',state:'preview',expiresAt:new Date(now+60000).toISOString(),skipped:[],orders:[{product:'BTC-USDC',side:'buy',baseSize:'0.1',limitPrice:'100',notional:'3.9',fee:'0.04',previewId:'fake',debits:[]},{product:'ZEC-USDC',side:'buy',baseSize:'0.1',limitPrice:'100',notional:'2.9',fee:'0.03',previewId:'fake',debits:[]}]}));
 const cbContinue=vi.fn(async(id:string)=>{
  const row=(await db.query<{account_id:string;state:string}>('SELECT * FROM coinbase_investments WHERE id=$1',[id])).rows[0];expect(row.account_id).toBe(accounts.coinbase);expect(row.state).toBe('funded');
  await db.query("UPDATE coinbase_investments SET state='dispatched' WHERE id=$1",[id]);
  return {state:'dispatched',error:null,review:{state:'settled',orders:[{execution:{state:'filled'}}]}};
 });
 const planner=createPlanner(database,{},()=>now);
 const execute=vi.fn(async()=>({placed:1,failed:0,parkedReason:null,allocationId:'fixture'}));
 const deps={clock:()=>now,enabled:()=>true,refresh,usdcRate:async()=> '1',checkRobinhood:vi.fn(async()=>{}),coinbaseOrders:{preview:cbPreview} as never,coinbaseInvestments:{continue:cbContinue,refresh:async()=>({state:'dispatched',error:null,review:{state:'settled',orders:[{execution:{state:'filled'}}]}})} as never,planner,executor:{executeAllocation:execute,settleLegs:async()=>{}}};
 const service=createMixedInvestments(database,deps);
 return {strategies,db,database,service,deps,takeId,accounts,cbContinue,execute,refresh,preview:()=>service.preview({takeId,operationId:randomUUID(),amountUsd:'10',coinbaseCurrency:'USDC'}),setCash:(v:string)=>{rhCash=v;now+=1000;},setBuyingPower:(v:string)=>{buyingPower=v;now+=1000;},open:async()=>{now=Date.parse('2026-10-14T15:00:00Z');await refresh();},spec};
}
test('real mixed wiring reserves both venue ledgers once and Robinhood plans only its equity sleeve',async()=>{
 const f=await fixture();const p=await f.preview();expect(p.executionEnabled).toBe(true);expect(p.legs.map(l=>l.quantity)).toEqual(['7','3']);
 const request={operationId:randomUUID(),previewId:p.id};const r=await f.service.invest(request);
 expect(r.legs[0].state).toBe('completed');expect(f.cbContinue).toHaveBeenCalledTimes(1);
 expect((await f.db.query<{quantity:string}>('SELECT quantity::text FROM coinbase_allocation_entries')).rows.map(r=>Number(r.quantity))).toEqual([7]);
 expect((await f.db.query<{cash:string}>('SELECT cash_delta::text AS cash FROM strategy_attribution_entries')).rows.map(r=>Number(r.cash))).toEqual([3]);
 const allocation=(await f.db.query<{id:string;strategy_id:string;applied_version_id:string}>('SELECT * FROM strategy_allocations')).rows[0];
 const sleeve=await executionBasket(f.db,f.spec,{strategyId:allocation.strategy_id,versionId:allocation.applied_version_id,accountId:f.accounts.robinhood},'robinhood');expect(sleeve.target.weights).toEqual([{instrument:{venue:'robinhood',symbol:'AAPL'},bps:10000}]);
 const legs=(await f.db.query<{symbol:string}>('SELECT symbol FROM strategy_executions')).rows;expect(legs.map(l=>l.symbol)).toEqual(['AAPL']);
 await f.service.invest(request);expect(f.cbContinue).toHaveBeenCalledTimes(1);expect((await f.db.query('SELECT * FROM coinbase_allocation_entries')).rows).toHaveLength(1);
});
test('insufficient Robinhood funds prevent either venue being funded or submitted',async()=>{
 const f=await fixture();f.setCash('1');const p=await f.preview();expect(p.state).toBe('blocked');await expect(f.service.invest({operationId:randomUUID(),previewId:p.id})).rejects.toThrow('blocked');
 expect((await f.db.query('SELECT * FROM coinbase_allocation_entries')).rows).toHaveLength(0);expect((await f.db.query('SELECT * FROM strategy_allocations')).rows).toHaveLength(0);expect(f.cbContinue).not.toHaveBeenCalled();
});
test('closed-market Robinhood child resumes after service restart without repeating Coinbase',async()=>{
 const f=await fixture(true);const p=await f.preview();expect(p.state).toBe('waiting_market');const r=await f.service.invest({operationId:randomUUID(),previewId:p.id});expect(r.legs.map(l=>l.state)).toEqual(['completed','waiting_market']);expect(f.execute).not.toHaveBeenCalled();
 await f.open();await createMixedInvestments(f.database,f.deps).tick();expect(f.execute).toHaveBeenCalledTimes(1);expect(f.cbContinue).toHaveBeenCalledTimes(1);
});

test('mixed Coinbase child uses the real investment/review services, preserves cash on an unsent failure, and retries without refunding or double funding',async()=>{
 const {createCoinbaseCapital}=await import('../../src/main/coinbase/capital');
 const {createCoinbaseOrderReviews}=await import('../../src/main/coinbase/order-reviews');
 const {createCoinbaseInvestments}=await import('../../src/main/coinbase/investment');
 const {createHash}=await import('node:crypto');
 const f=await fixture(true);let failing=false;
 const clock=f.deps.clock;
 const orders=createCoinbaseOrderReviews(f.database,{
  enabled:()=>true,refresh:async()=>{},
  scope:async(id:string)=>{const c=(await f.db.query<{id:string;credential_ref:string|null;external_account_ref:string;can_trade:boolean}>(`SELECT c.id,c.credential_ref,c.external_account_ref,d.can_trade FROM platform_connections c JOIN linked_accounts a ON a.connection_id=c.id JOIN coinbase_connection_details d ON d.connection_id=c.id WHERE a.id=$1`,[id])).rows[0];return {accountRef:id,label:'Synthetic',authority:createHash('sha256').update(JSON.stringify([c.id,id,c.credential_ref,c.external_account_ref,c.can_trade])).digest('hex')};},
  product:async(_scope,id)=>({product_id:id,base_currency_id:id.split('-')[0],quote_currency_id:'USDC',product_type:'SPOT',price:'100',base_increment:'0.0001',quote_increment:'0.01',price_increment:'0.01',base_min_size:'0.0001',base_max_size:'10000',quote_min_size:'1',quote_max_size:'1000000',is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,view_only:false,status:'online'}),
  preview:async(_scope,candidates)=>{if(failing)throw Error('Synthetic provider unavailable');return candidates.map(()=>({preview_id:randomUUID(),commission_total:'0.01',errs:[]}));},
 },clock);
 const submit=vi.fn(async()=>{});
 const execution={submit,refresh:async()=>{},cancel:async()=>{},view:async(id:string)=>{const row=await orders.load(id);return {...row.payload,state:row.state};}};
 const capital=createCoinbaseCapital(f.database,clock);
 const investments=createCoinbaseInvestments(f.database,capital,orders,execution as never,async()=>{},clock);
 const service=createMixedInvestments(f.database,{...f.deps,coinbaseOrders:orders,coinbaseInvestments:investments});
 const preview=await service.preview({takeId:f.takeId,operationId:randomUUID(),amountUsd:'10',coinbaseCurrency:'USDC'});
 failing=true;const request={operationId:randomUUID(),previewId:preview.id};const initial=await service.invest(request);
 expect(initial.legs[0].state).toBe('attention');expect(submit).not.toHaveBeenCalled();
 const child=(await f.db.query<{state:string}>('SELECT state FROM coinbase_investments')).rows[0];expect(child.state).toBe('funded');
 expect((await capital.view(f.takeId)).balances.find(b=>b.asset==='USDC')?.quantity).toBe('7');
 expect((await capital.activity(f.accounts.coinbase)).map(a=>a.quantity)).toEqual(['7']);
 failing=false;const retried=await service.invest(request);expect(retried.legs[0].state).toBe('pending');expect(submit).toHaveBeenCalledTimes(1);
 expect((await f.db.query('SELECT * FROM coinbase_allocation_entries')).rows).toHaveLength(1);
 await service.invest(request);expect(submit).toHaveBeenCalledTimes(1);
});

test('a changed balance after review blocks both ledger writes',async()=>{
 const f=await fixture();const preview=await f.preview();f.setCash('1');await f.refresh();
 await expect(f.service.invest({operationId:randomUUID(),previewId:preview.id})).rejects.toThrow(/insufficient buying power|Balances or holdings changed/);
 expect((await f.db.query('SELECT * FROM coinbase_capital_reviews')).rows).toHaveLength(0);
 expect((await f.db.query('SELECT * FROM strategy_allocations')).rows).toHaveLength(0);
 expect(f.cbContinue).not.toHaveBeenCalled();
});
test('standalone Coinbase funding cannot bypass combined review',async()=>{
 const {createCoinbaseCapital}=await import('../../src/main/coinbase/capital');
 const f=await fixture();await f.refresh();const capital=createCoinbaseCapital(f.database,f.deps.clock);
 await expect(capital.preview({takeId:f.takeId,kind:'assign',asset:'USDC',quantity:'7'})).rejects.toThrow('combined account review');
 expect((await f.db.query('SELECT * FROM coinbase_allocation_entries')).rows).toHaveLength(0);
});

test('Robinhood available buying power caps funding even when the cash balance is higher',async()=>{const f=await fixture();f.setBuyingPower('1');const p=await f.preview();expect(p.state).toBe('blocked');expect(p.legs.find(l=>l.venue==='robinhood')?.available).toBe('1');expect(f.cbContinue).not.toHaveBeenCalled();});

async function settleSyntheticRobinhood(f:Awaited<ReturnType<typeof fixture>>,state='filled'){
 await f.db.query('UPDATE strategy_executions SET status=$1',[state]);
 await f.db.query('UPDATE strategy_allocation_transactions SET pending_reason=NULL');
 await f.service.tick();
}
test('a second mixed deposit reuses both accounts and allocations, includes held cash, and remains idempotent',async()=>{
 const f=await fixture();const initial=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:initial.id});
 await settleSyntheticRobinhood(f);
 const ids=(await f.db.query('SELECT id FROM coinbase_allocations UNION ALL SELECT id FROM strategy_allocations')).rows;
 const preview=await f.preview();
 expect(preview.legs.map(l=>Number(l.existingCash??0))).toEqual([7,3]);
 const request={operationId:randomUUID(),previewId:preview.id};await f.service.invest(request);await f.service.invest(request);
 expect((await f.db.query('SELECT id FROM coinbase_allocations UNION ALL SELECT id FROM strategy_allocations')).rows).toEqual(ids);
 expect(Number((await f.db.query<{v:string}>('SELECT sum(quantity)::text AS v FROM coinbase_allocation_entries')).rows[0].v)).toBe(14);
 expect(Number((await f.db.query<{v:string}>('SELECT sum(cash_delta)::text AS v FROM strategy_attribution_entries')).rows[0].v)).toBe(6);
 expect((await f.db.query("SELECT kind FROM strategy_allocation_transactions ORDER BY sequence")).rows.map(r=>r.kind)).toEqual(['investment','contribution']);
 expect(f.cbContinue).toHaveBeenCalledTimes(2);
});
test('pending mixed execution prevents another deposit, while terminal cancellation permits new funding',async()=>{
 const f=await fixture();const p=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:p.id});
 await expect(f.preview()).rejects.toThrow('Wait for the current investment');
 await settleSyntheticRobinhood(f,'cancelled');
 expect((await f.service.current(f.takeId))?.legs.find(l=>l.venue==='robinhood')?.state).toBe('cancelled');
 expect((await f.service.current(f.takeId))?.state).toBe('completed');
 expect((await f.preview()).state).toBe('ready');
});
test('mixed investment readiness refuses while a rule rebalance is working, not after a partial rebalance',async()=>{
 const f=await fixture(),request=randomUUID();
 const version=(await f.db.query<{id:string}>('SELECT s.current_version_id AS id FROM takes t JOIN strategies s ON s.id=t.strategy_id WHERE t.id=$1',[f.takeId])).rows[0].id;
 await f.db.query("INSERT INTO strategy_rule_draft_revisions(take_id,revision,accepted_version,input_revision,config) VALUES($1,1,$2,0,'{}')",[f.takeId,version]);
 await f.db.query("INSERT INTO strategy_rule_action_requests(id,take_id,draft_revision,rule_id,firing_key,created_at,expires_at,status,action,evidence) VALUES($1,$2,1,$3,'synthetic',now(),now()+interval '1 hour','shadow','{}','{}')",[request,f.takeId,randomUUID()]);
 await f.db.query("INSERT INTO strategy_rule_trades(request_id,take_id,account_id,state) VALUES($1,$2,$3,'working')",[request,f.takeId,f.accounts.coinbase]);
 await expect(f.preview()).rejects.toThrow('rule rebalance is running');
 await f.db.query("UPDATE strategy_rule_trades SET state='attention',reason='partial_rebalance'");
 expect((await f.preview()).state).toBe('ready');
});
test('Robinhood scheduler waits for the parent and uses only its venue after settlement',async()=>{
 const {createExecutionScheduler}=await import('../../src/main/execution/scheduler');
 const f=await fixture();const p=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:p.id});
 const plan=vi.fn(async(id:string)=>({allocationId:id,planId:null,disposition:'noop' as const,reasonCode:null,executionIds:[],sleeves:[]}));
 const scheduler=createExecutionScheduler(f.database,{planner:{...f.deps.planner,planAllocation:plan} as never,executor:f.deps.executor,clock:f.deps.clock});
 await scheduler.tick();expect(plan).not.toHaveBeenCalled();
 await settleSyntheticRobinhood(f);
 await f.db.query('UPDATE strategy_allocations SET applied_version_sequence=0');
 await scheduler.tick();expect(plan).toHaveBeenCalledTimes(1);
});
test('mixed account close releases uninvested Robinhood cash without releasing Coinbase capital',async()=>{
 const {createAllocationInstructions}=await import('../../src/main/execution/instructions');
 const {createAllocationCore}=await import('../../src/main/allocations/service');
 const f=await fixture();const p=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:p.id});await settleSyntheticRobinhood(f);
 const a=(await f.db.query<{id:string}>('SELECT id FROM strategy_allocations')).rows[0];
 const instructions=createAllocationInstructions(f.database,{core:createAllocationCore(f.database,f.deps.clock),planner:f.deps.planner,executor:f.deps.executor,clock:f.deps.clock});
 await instructions.close(a.id,'none');
 expect(Number((await f.db.query<{v:string}>('SELECT sum(cash_delta)::text AS v FROM strategy_attribution_entries')).rows[0].v)).toBe(0);
 expect(Number((await f.db.query<{v:string}>('SELECT sum(quantity)::text AS v FROM coinbase_allocation_entries')).rows[0].v)).toBe(7);
});

test('reviewed mixed version adoption changes both accounts atomically and enables venue rebalancing',async()=>{
 const {createCoinbaseLifecycle}=await import('../../src/main/coinbase/lifecycle');
 const f=await fixture();const p=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:p.id});await settleSyntheticRobinhood(f);
 const row=(await f.db.query<{draft_revision_id:string;current_version_id:string;id:string}>('SELECT s.* FROM strategies s JOIN takes t ON t.strategy_id=s.id WHERE t.id=$1',[f.takeId])).rows[0];
 const next={...f.spec,rebalance:{...f.spec.rebalance,driftBandPoints:1},target:{...f.spec.target,weights:f.spec.target.weights.map(w=>({...w,bps:w.instrument.symbol==='BTC'?5000:w.instrument.symbol==='ZEC'?2000:3000}))}};
 const proposal=await f.strategies.propose({targetTakeId:f.takeId,expectedRevision:row.draft_revision_id,expectedVersion:row.current_version_id,operationId:randomUUID(),metadata:{title:'Mixed fixture',description:'',rationale:'',holdings:[]},spec:next,unsupportedRequests:[]});if(!proposal.ok)throw Error(proposal.message);
 const commit=await f.strategies.commit({targetTakeId:f.takeId,expectedRevision:proposal.view.draft.id,expectedVersion:row.current_version_id,operationId:randomUUID()});if(!commit.ok)throw Error(commit.message);
 const lifecycle=createCoinbaseLifecycle(f.database,f.deps.clock);const before=await lifecycle.view(f.takeId);
 const adopted=await lifecycle.decide({takeId:f.takeId,evidence:before.evidence,action:'adopt'});
 expect(adopted.versionId).toBe(adopted.currentVersionId);expect(adopted.driftEnabled).toBe(true);
 const rh=(await f.db.query<{accepted_version_id:string}>('SELECT accepted_version_id FROM strategy_allocations')).rows[0];expect(rh.accepted_version_id).toBe(adopted.versionId);
 expect((await executionBasket(f.db,next,{strategyId:row.id,versionId:adopted.versionId,accountId:f.accounts.robinhood},'robinhood')).target.weights).toHaveLength(1);
});

test('mixed performance includes Robinhood holdings and Coinbase cash with venue-correct price reads',async()=>{
 const {append}=await import('../../src/main/allocations/ledger');
 const {createCoinbaseTakePerformance}=await import('../../src/main/coinbase/take-performance');
 const f=await fixture();const p=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:p.id});await settleSyntheticRobinhood(f);
 const a=(await f.db.query<{id:string;strategy_id:string}>('SELECT id,strategy_id FROM strategy_allocations')).rows[0];
 const transaction=(await f.db.query<{id:string}>('SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1',[a.id])).rows[0];
 const at=new Date(f.deps.clock()).toISOString();
 await f.db.transaction(tx=>append(tx,{allocationId:a.id,transactionId:transaction.id,entryType:'fill',instrumentRef:'AAPL',symbol:'AAPL',quantityDelta:'0.03',cashDelta:'-3',cause:'synthetic:buy',sourceKind:'member_instruction',sourceRef:transaction.id,occurredAt:at},at));
 f.setCash('97');const now=f.deps.clock();
 await f.db.query("INSERT INTO market_quotes(symbol,price,observed_at) VALUES('AAPL',110,$1) ON CONFLICT(symbol) DO UPDATE SET price=110,observed_at=excluded.observed_at",[new Date(now).toISOString()]);
 await f.db.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)',[f.accounts.coinbase,new Date(now).toISOString(),JSON.stringify({portfolio:{currency:'USD'},spotPositions:[{asset:'USDC',currency:'USD',quantity:'100',marketValue:'100'}]})]);
 const equities={series:vi.fn(async(_id:string,symbols:string[])=>{expect(symbols).toEqual(['AAPL']);return [{symbol:'AAPL',interval:'hour',points:[{t:new Date(now-3600000).toISOString(),c:'100',s:'regular'},{t:new Date(now).toISOString(),c:'110',s:'regular'}]}] as never;})};
 const performance=createCoinbaseTakePerformance(f.database,{dailySpot:async()=> '1',candles:async()=>{throw Error('Equities must not use Coinbase candles');}},f.deps.clock,equities);
 expect(Number((await performance.summary(a.strategy_id))?.gain)).toBeCloseTo(.3);
 const chart=await performance.performance(a.strategy_id,'1d',f.spec);
 expect(chart.actualAvailable).toBe(true);expect(chart.investors).toBe(2);expect(Number(chart.stats[0].allTimeReturnPercent)).toBeCloseTo(3);
});

test('closing both venue cash allocations permits investing again without reviving closed Robinhood allocations',async()=>{
 const {createCoinbaseLifecycle}=await import('../../src/main/coinbase/lifecycle');
 const {createAllocationInstructions}=await import('../../src/main/execution/instructions');
 const {createAllocationCore}=await import('../../src/main/allocations/service');
 const f=await fixture();const p=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:p.id});await settleSyntheticRobinhood(f);
 const a=(await f.db.query<{id:string}>('SELECT id FROM strategy_allocations')).rows[0];
 const lifecycle=createCoinbaseLifecycle(f.database,f.deps.clock);const view=await lifecycle.view(f.takeId);await lifecycle.decide({takeId:f.takeId,evidence:view.evidence,action:'release'});
 const instructions=createAllocationInstructions(f.database,{core:createAllocationCore(f.database,f.deps.clock),planner:f.deps.planner,executor:f.deps.executor,clock:f.deps.clock});await instructions.close(a.id,'none');
 const preview=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:preview.id});
 expect((await f.db.query('SELECT id FROM coinbase_allocations')).rows).toHaveLength(1);
 expect((await f.db.query("SELECT id FROM strategy_allocations WHERE status='active'")).rows).toHaveLength(1);
 expect((await f.db.query("SELECT id FROM strategy_allocations WHERE status='detached'")).rows).toEqual([{id:a.id}]);
 expect(Number((await f.db.query<{v:string}>('SELECT sum(quantity)::text AS v FROM coinbase_allocation_entries')).rows[0].v)).toBe(7);
});

test('Coinbase drift scheduler takes over only after the shared investment finishes',async()=>{
 const {createCoinbaseScheduler}=await import('../../src/main/coinbase/scheduler');
 const {NoCoinbaseOrdersError}=await import('../../src/main/coinbase/order-reviews');
 const f=await fixture(false,1);const p=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:p.id});
 await f.db.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)',[f.accounts.coinbase,new Date(f.deps.clock()).toISOString(),JSON.stringify({portfolio:{currency:'USD'},spotPositions:[{asset:'USDC',currency:'USD',quantity:'100',marketValue:'100'}]})]);
 const preview=vi.fn(async()=>{throw new NoCoinbaseOrdersError('Synthetic: below Coinbase minimum');});
 const scheduler=createCoinbaseScheduler(f.database,{...f.deps.coinbaseOrders,preview},{busy:()=>false} as never,()=>true,f.deps.clock);
 await scheduler.tick();expect(preview).not.toHaveBeenCalled();
 await settleSyntheticRobinhood(f);await scheduler.tick();expect(preview).toHaveBeenCalledTimes(1);
 expect((await f.db.query('SELECT trigger,warning_code FROM coinbase_rebalance_runs')).rows).toEqual([{trigger:'drift',warning_code:'below_minimum'}]);
});

test('overlapping account reviews wait for the current pass instead of showing a busy error',async()=>{
 const f=await fixture();const [first,second]=await Promise.all([f.preview(),f.preview()]);
 expect(first.state).toBe('ready');expect(second.state).toBe('ready');
 expect((await f.db.query('SELECT * FROM coinbase_allocation_entries')).rows).toHaveLength(0);
});


test('second mixed deposit conserves sub-cent Robinhood cash left by a fractional fill',async()=>{
 const f=await fixture();const initial=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:initial.id});
 await settleSyntheticRobinhood(f);
 // Disposable ledger fixture: reproduce the cash remainder after the first fill.
 const {append}=await import('../../src/main/allocations/ledger');
 const entry=(await f.db.query<{allocation_id:string;transaction_id:string}>('SELECT allocation_id,transaction_id FROM strategy_attribution_entries LIMIT 1')).rows[0];
 await f.db.transaction(tx=>append(tx,{allocationId:entry.allocation_id,transactionId:entry.transaction_id,entryType:'fill',cause:'synthetic-fill-cash',cashDelta:'-2.9998086921',sourceKind:'test',sourceRef:'synthetic-fill',occurredAt:new Date(f.deps.clock()).toISOString()},new Date(f.deps.clock()).toISOString()));
 const preview=await f.preview();
 const rh=preview.legs.find(l=>l.venue==='robinhood')!;
 expect(rh).toMatchObject({state:'ready',quantity:'3',existingCash:'0.0001913079',retainedCash:'0.0001913079'});
 expect(rh.orders).toEqual([{symbol:'AAPL',side:'buy',notional:'3',fee:'0'}]);
 expect(preview.state).toBe('ready');
});

test('whole Take withdrawal adapters read saved routes, size both accounts and retain cash currencies on close',async()=>{
 const {mixedWithdrawalAdapters}=await import('../../src/main/mixed-execution/withdrawal-adapters');
 const {createMixedWithdrawals}=await import('../../src/main/mixed-execution/withdrawal');
 const f=await fixture();const strategyId=(await f.db.query<{strategy_id:string}>('SELECT strategy_id FROM takes WHERE id=$1',[f.takeId])).rows[0].strategy_id;
 const bucket=randomUUID();
 const version=(await f.db.query<{id:string}>('SELECT id FROM strategy_versions WHERE strategy_id=$1',[strategyId])).rows[0].id;
 await f.db.query("INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,applied_version_sequence,accepted_version_id,status,allocation_value,currency,created_at,updated_at) VALUES($1,$2,$3,$4,1,$4,'active',6.7,'USD',now(),now())",[bucket,f.accounts.robinhood,strategyId,version]);
 const h={strategy:{id:strategyId},bucket:{id:bucket,status:'active'},positions:[{symbol:'AAPL',quantity:'0.06',value:'6'},{symbol:'MSFT',quantity:'0.001',value:'0.5'}],valuation:{complete:true,currency:'USD',cash:'0.2',totalValue:'6.7'},requiresReconciliation:false,openExecutions:false};
 const cbReview=vi.fn(async(input:{close?:boolean;withdrawAmount?:string})=>({id:randomUUID(),quote:'USDC',expiresAt:new Date(Date.now()+60000).toISOString(),orders:input.close?[]:[{product:'BTC-USDC',baseSize:'0.01',notional:input.withdrawAmount}],closeCash:input.close?[{asset:'USDC',quantity:'0.1'},{asset:'USD',quantity:'0.05'}]:[],closePositions:[],withdrawal:{estimatedProceeds:input.withdrawAmount??'0.1'}}));
 const rhPreview=vi.fn(async(_id:string,amount:string)=>({ok:true,band:{minimumAmount:'1',maximumAmount:'5',possible:true},legs:[{symbol:'AAPL',notional:amount}]}));
 const adapters=mixedWithdrawalAdapters(f.database,{executor:f.deps.executor,enabled:()=>true,rate:async()=> '1',
  instructions:{holdings:async()=>({holdings:[h]}),redemptionPreview:rhPreview} as never,
  capital:{view:async()=>({accountId:f.accounts.coinbase,valuation:{value:'14.15',currency:'USD'},balances:[{asset:'BTC',quantity:'0.01',reserved:'0',value:'14'},{asset:'USDC',quantity:'0.1',reserved:'0',value:'0.1'}]})} as never,
  orders:{preview:cbReview,withdrawalBand:async()=>({minimumAmount:'1',maximumAmount:'12',possible:true})} as never,execution:{} as never});
 const service=createMixedWithdrawals(f.database,adapters),p=await service.preview({takeId:f.takeId,kind:'reduce',amountUsd:'10',coinbaseCurrency:'USDC'});
 expect(p.legs.map(l=>l.amount)).toEqual(['6.82','3.18']);expect(rhPreview).toHaveBeenCalledWith(bucket,'3.18');expect(cbReview).toHaveBeenCalledWith(expect.objectContaining({withdrawAmount:'6.82'}));
 const close=await service.preview({takeId:f.takeId,kind:'close',coinbaseCurrency:'USDC'});
 expect(close.legs[0].cashRows).toEqual([{asset:'USDC',quantity:'0.1'},{asset:'USD',quantity:'0.05'}]);
 expect(close.legs[1].orders.map(o=>[o.symbol,o.selected,o.sellable])).toEqual([['AAPL',true,true],['MSFT',false,false]]);
});

test('action notification rollup persists one mixed parent and updates it without duplicate receipts',async()=>{
 const {syncActionNotifications}=await import('../../src/main/action-notifications');
 const f=await fixture();const p=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:p.id});
 await syncActionNotifications(f.db,f.deps.clock());
 const first=(await f.db.query<{id:string;payload:{action:{id:string;state:string}}}>("SELECT id,payload FROM notifications WHERE NOT pruned AND payload->>'kind'='action_update'")).rows;
 expect(first).toHaveLength(1);expect(first[0].payload.action.id).toMatch(/^mixed:/);expect(first[0].payload.action.state).not.toBe('completed');
 await syncActionNotifications(f.db,f.deps.clock()+1000);
 expect((await f.db.query("SELECT id FROM notifications WHERE NOT pruned AND payload->>'kind'='action_update'")).rows).toEqual([{id:first[0].id}]);
});

test('grouped child alerts are suppressed and terminal progress updates the existing parent',async()=>{
 const {syncActionNotifications}=await import('../../src/main/action-notifications');
 const f=await fixture();const p=await f.preview();await f.service.invest({operationId:randomUUID(),previewId:p.id});
 const t=(await f.db.query<{id:string}>('SELECT id FROM strategy_allocation_transactions WHERE kind=\'investment\'')).rows[0];
 await f.db.query('SELECT record_local_notification($1::jsonb,false)',[JSON.stringify({kind:'capital_update',context:{strategyId:'fixture'},source:{type:'take_event',id:`${t.id}:capital_allocated`},eventKey:'receipt',title:'Deposited',body:'',requiresAction:false,tier:'know_today',occurredAt:new Date(f.deps.clock()).toISOString()})]);
 await syncActionNotifications(f.db,f.deps.clock());
 expect((await f.db.query("SELECT delivery,pruned FROM notifications WHERE payload->>'kind'='capital_update'")).rows).toEqual([{delivery:'suppressed',pruned:true}]);
 const first=(await f.db.query<{id:string;sequence:string}>("SELECT id,sequence::text FROM notifications WHERE payload->>'kind'='action_update' AND NOT pruned")).rows[0];
 await f.db.query("UPDATE notifications SET seen=true WHERE id=$1",[first.id]);
 await f.db.query("UPDATE strategy_allocation_transactions SET outcome='failed' WHERE id=$1",[t.id]);
 await syncActionNotifications(f.db,f.deps.clock()+1000);
 const next=(await f.db.query<{id:string;seen:boolean;sequence:string;payload:{action:{state:string}}}>("SELECT id,seen,sequence::text,payload FROM notifications WHERE payload->>'kind'='action_update' AND NOT pruned")).rows[0];
 expect(next.id).toBe(first.id);expect(next.seen).toBe(false);expect(next.payload.action.state).toBe('attention');expect(BigInt(next.sequence)).toBeGreaterThan(BigInt(first.sequence));
 await syncActionNotifications(f.db,f.deps.clock()+2000);
 expect((await f.db.query<{sequence:string}>('SELECT sequence::text FROM notifications WHERE id=$1',[first.id])).rows[0].sequence).toBe(next.sequence);
});
