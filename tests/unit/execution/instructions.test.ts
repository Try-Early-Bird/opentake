import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {append,instruction} from '../../../src/main/allocations/ledger';
import {reconcile} from '../../../src/main/allocations/reconciliation';
import {createAllocationInstructions,authorResult,replicationState} from '../../../src/main/execution/instructions';
import type {PlanResult,PlanTrigger} from '../../../src/main/execution/contracts';

// Synthetic account: 20 VTI marked at $10, $1,000 cash and buying power, $1,200 total.
// A committed strategy: 80% VTI, 20% cash. Planner, executor and Robinhood are stubs.
async function fixture(options:{tradability?:boolean;shares?:string;mixed?:boolean;cryptoRead?:()=>unknown}={}){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=Date.parse('2026-10-05T15:00:00Z');let shares=options.shares??'20';
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const status=async()=>({status:'connected' as const,checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]});
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{status,
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:shares,mark_price:'10'}]}:{results:[]},
 } as never,()=>now);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 const spec={schemaVersion:1,kind:'basket',target:{weights:[{instrument:{venue:'robinhood',symbol:'VTI'},bps:8000}],cashBps:2000},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}};
 if(options.mixed) spec.target.weights=[{instrument:{venue:'robinhood',symbol:'VTI'},bps:4000},{instrument:{venue:'coinbase',symbol:'VTI'},bps:4000}];
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,$3,$4,'{}','{}' FROM local_owners`,
  [version,strategy,JSON.stringify({title:'Fixture basket',description:'Synthetic'}),JSON.stringify(spec)]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const confirmations:boolean[]=[];
 const plans:{allocationId:string;trigger:string}[]=[],liquidations:{allocationId:string;input:unknown}[]=[],executed:string[]=[];
 let disposition:PlanResult['disposition']='planned';
 const result=(allocationId:string):PlanResult=>({allocationId,planId:null,disposition,reasonCode:disposition==='planned'?null:'market_closed',executionIds:[],sleeves:[]});
 const instructions=createAllocationInstructions(database,{
  core:createAllocationCore(database,()=>now),
  planner:{planAllocation:async(allocationId:string,trigger:PlanTrigger)=>{plans.push({allocationId,trigger});return result(allocationId);},
   planLiquidation:async(allocationId,input)=>{liquidations.push({allocationId,input});return result(allocationId);}},
  executor:{executeAllocation:async(allocationId,options)=>{executed.push(allocationId);confirmations.push(!!options?.confirmed);return {allocationId,placed:1,failed:0,parkedReason:null};},settleLegs:async()=>{}},
  ...(options.tradability===false?{}:{connections:{status,readTool:async(_name:string,args:Record<string,unknown>)=>_name==='get_crypto_eligibility'?options.cryptoRead?.():({results:(args.symbols as string[]).map(symbol=>({symbol,tradeable:true,fractional_tradability:'tradable'}))})} as never}),
  clock:()=>now,
 });
 const leg=async(allocationId:string,status:string,extra:{transactionId?:string;kind?:string;failureCode?:string;createdAt?:string}={})=>{
  const id=randomUUID();const at=extra.createdAt??new Date(now).toISOString();
  await db.query(`INSERT INTO strategy_executions(id,allocation_id,account_id,strategy_id,transaction_id,kind,symbol,side,status,order_request,idempotency_key,request_hash,failure_code,created_at,updated_at,terminal_at)
   VALUES($1,$2,$3,$4,$5,$6,'VTI','buy',$7,'{}',$8,$9,$10,$11,$11,$12)`,[id,allocationId,account,strategy,extra.transactionId??null,extra.kind??'subscribe',status,randomUUID(),createHash('sha256').update(id).digest('hex'),extra.failureCode??null,at,
   ['filled','failed','cancelled'].includes(status)?at:null]);
  return id;
 };
 /** Gives an allocation shares as if its first buy filled: 5 VTI for $50. */
 const fill=async(allocationId:string)=>db.transaction(async tx=>{
  const at=new Date(now).toISOString();
  const transactionId=await instruction(tx,{allocationId,kind:'rebalance',cause:`fill:${randomUUID()}`},at);
  await append(tx,{allocationId,transactionId,entryType:'fill',instrumentRef:'VTI',symbol:'VTI',quantityDelta:'5',cashDelta:'-50',unitCost:'10',cause:`fill:${randomUUID()}`,sourceKind:'provider_execution',sourceRef:'synthetic',occurredAt:at},at);
 });
 const invest=async(value='100')=>{const created=await instructions.create({strategyId:strategy,financialAccountId:account,allocationValue:value});return created.id;};
 return {db,account,strategy,instructions,plans,liquidations,executed,confirmations,leg,fill,invest,
  setDisposition:(d:PlanResult['disposition'])=>{disposition=d;},
  resync:async(next:string)=>{shares=next;now+=1000;await sync.synchronize();},
  later:(ms:number)=>{now+=ms;},close:async()=>{sync.cancel();await db.close();}};
}

test('investing runs the activation checks, then sets the money aside for the first plan',async()=>{
 const f=await fixture();try{
  const refused=async(value:string)=>authorResult(()=>f.instructions.create({strategyId:f.strategy,financialAccountId:f.account,allocationValue:value}));
  expect(await refused('1300')).toMatchObject({ok:false,status:409,code:'allocation_exceeds_account'});
  expect(await refused('1100')).toMatchObject({ok:false,code:'insufficient_cash'});
  expect(await refused('1')).toMatchObject({ok:false,code:'allocation_below_minimum'});
  expect(await refused('abc')).toMatchObject({ok:false,code:'invalid_amount'});
  await f.instructions.setTradingPreferences({blockedSymbols:['VTI']});
  expect(await refused('100')).toMatchObject({ok:false,code:'symbol_blocked'});
  await f.instructions.setTradingPreferences({blockedSymbols:[]});
  const id=await f.invest('100');
  const a=(await f.db.query<{status:string;allocation_value:string}>(`SELECT status,allocation_value::text FROM strategy_allocations WHERE id=$1`,[id])).rows[0];
  expect(a).toMatchObject({status:'active'});expect(Number(a!.allocation_value)).toBe(100);
  expect((await f.db.query(`SELECT kind,pending_reason FROM strategy_allocation_transactions WHERE allocation_id=$1`,[id])).rows).toEqual([{kind:'investment',pending_reason:'requested'}]);
  expect(await refused('50')).toMatchObject({ok:false,code:'already_following'});
  const started=await f.instructions.update(id,{status:'active'});
  expect(started).toMatchObject({status:'active',disposition:'planned'});
  expect(f.plans).toEqual([{allocationId:id,trigger:'activation'}]);expect(f.executed).toEqual([id]);
 }finally{await f.close();}
});

test('activation fails closed without a live tradability answer',async()=>{
 const f=await fixture({tradability:false});try{
  expect(await authorResult(()=>f.instructions.create({strategyId:f.strategy,financialAccountId:f.account,allocationValue:'100'}))).toMatchObject({ok:false,code:'tradability_check_unavailable'});
 }finally{await f.close();}
});

test('a deposit records a waiting contribution, raises the allocation and plans it',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');
  await f.instructions.update(id,{status:'paused'});
  expect(await authorResult(()=>f.instructions.deposit(id,'50'))).toMatchObject({ok:false,code:'bucket_not_active'});
  await f.instructions.update(id,{status:'active'});
  expect(await authorResult(()=>f.instructions.deposit(id,'5000'))).toMatchObject({ok:false,code:'insufficient_cash'});
  f.plans.length=0;
  await f.instructions.deposit(id,'50');
  expect(Number((await f.db.query<{v:string}>(`SELECT allocation_value::text AS v FROM strategy_allocations WHERE id=$1`,[id])).rows[0]!.v)).toBe(150);
  expect(f.plans).toEqual([{allocationId:id,trigger:'deposit'}]);
  const live=await f.instructions.instructions(id);
  expect(live.instructions.map(i=>[i.kind,i.status,i.requestedAmount,i.cancellable])).toContainEqual(['contribution','pending','50',true]);
 }finally{await f.close();}
});

test('withdrawals preview a band, refuse outside it, and run with what was shown',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');await f.fill(id);
  const preview=await f.instructions.redemptionPreview(id,'10');
  expect(preview).toMatchObject({ok:true,amount:'10',band:{possible:true}});
  expect(preview.legs.map(l=>l.symbol)).toEqual(['VTI']);
  expect(await authorResult(()=>f.instructions.redeem(id,'99'))).toMatchObject({ok:false,code:'above_band'});
  f.setDisposition('deferred');
  const result=await f.instructions.redeem(id,'10') as {disposition:string;instruction:{kind:string;status:string;previewLegs:unknown[]}};
  expect(result).toMatchObject({disposition:'deferred',instruction:{kind:'partial_redemption',previewLegs:[{symbol:'VTI'}]}});
  expect(f.liquidations.at(-1)).toMatchObject({allocationId:id,input:{kind:'redeem',amount:'10'}});
  // A second request supersedes the first, still pending.
  await f.instructions.redeem(id,'12');
  expect((await f.db.query(`SELECT outcome FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='redemption' ORDER BY created_at,sequence`,[id])).rows.map(r=>(r as {outcome:string|null}).outcome)).toEqual(['superseded',null]);
 }finally{await f.close();}
});

test('a settled withdrawal appears in Take activity with the proceeds it released',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');await f.fill(id);
  await f.instructions.redeem(id,'10');
  const t=(await f.db.query<{id:string;account_id:string}>(`SELECT t.id,a.account_id FROM strategy_allocation_transactions t JOIN strategy_allocations a ON a.id=t.allocation_id WHERE t.allocation_id=$1 AND t.kind='redemption'`,[id])).rows[0]!;
  expect((await f.instructions.activity(f.strategy)).events.some(e=>e.kind==='withdrawn')).toBe(false);
  const sequence=(await f.db.query<{n:number}>('SELECT coalesce(max(sequence),0)::int+1 AS n FROM strategy_attribution_entries WHERE allocation_id=$1',[id])).rows[0]!.n;
  await f.db.query(`INSERT INTO strategy_attribution_entries(id,allocation_id,account_id,transaction_id,sequence,entry_type,cash_delta,currency,source_kind,source_ref,idempotency_key,request_hash,occurred_at,recorded_at)
   VALUES(gen_random_uuid(),$1,$2,$3,$4,'capital_released',-9.97,'USD','member_instruction',$6,$5,'h',now(),now())`,[id,t.account_id,t.id,sequence,'settle:'+t.id,t.id]);
  const withdrawn=(await f.instructions.activity(f.strategy)).events.filter(e=>e.kind==='withdrawn');
  expect(withdrawn).toEqual([expect.objectContaining({id:`withdrawal:${t.id}`,amount:'9.970000000000000000',member:expect.objectContaining({isViewer:true})})]);
 }finally{await f.close();}
});

test('cancelling: a deposit retains cash without immediately replanning; sent or finished instructions refuse',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');
  await f.instructions.deposit(id,'50');
  const deposit=(await f.instructions.instructions(id)).instructions.find(i=>i.kind==='contribution')!;
  const sent=await f.leg(id,'submitted');
  expect(await authorResult(()=>f.instructions.cancelInstruction(id,deposit.id))).toMatchObject({ok:false,code:'instruction_submitted'});
  await f.db.query(`UPDATE strategy_executions SET status='filled' WHERE id=$1`,[sent]);
  f.plans.length=0;
  const cancelled=await f.instructions.cancelInstruction(id,deposit.id);
  expect(cancelled).toMatchObject({status:'cancelled',outcomeCode:'member'});
  expect(Number((await f.db.query<{v:string}>(`SELECT allocation_value::text AS v FROM strategy_allocations WHERE id=$1`,[id])).rows[0]!.v)).toBe(150);
  expect(f.plans).toEqual([]);
  expect((await f.instructions.activity(f.strategy)).events.some(e=>e.id===deposit.id)).toBe(true);
  expect((await f.db.query("SELECT 1 FROM strategy_attribution_entries WHERE allocation_id=$1 AND entry_type='capital_released'",[id])).rows).toHaveLength(0);
  // Idempotent once cancelled.
  expect(await f.instructions.cancelInstruction(id,deposit.id)).toMatchObject({status:'cancelled'});
  const exit=await f.db.transaction(tx=>instruction(tx,{allocationId:id,kind:'exit',cause:'exit:fixture',pendingReason:'requested'},new Date().toISOString()));
  expect(await authorResult(()=>f.instructions.cancelInstruction(id,exit))).toMatchObject({ok:false,code:'instruction_not_cancellable'});
 }finally{await f.close();}
});

test('closing: none releases the claims now; all sells, and the sweep detaches once the sells settle',async()=>{
 const f=await fixture();try{
  const held=await f.invest('100');await f.fill(held);
  await f.instructions.close(held,'none');
  expect((await f.db.query(`SELECT status FROM strategy_allocations WHERE id=$1`,[held])).rows).toEqual([{status:'detached'}]);
  expect((await f.db.query(`SELECT status FROM strategy_allocation_closures WHERE allocation_id=$1`,[held])).rows).toEqual([{status:'held'}]);
  expect((await f.db.query<{q:string}>(`SELECT coalesce(sum(quantity_delta),0)::text AS q FROM strategy_attribution_entries WHERE allocation_id=$1`,[held])).rows[0]!.q).toMatch(/^0(\.0+)?$/);
  expect(await authorResult(()=>f.instructions.close(held,'all'))).toMatchObject({ok:false,code:'bucket_not_following'});
  expect((await f.instructions.holdings()).holdings).toEqual([]);

  const sold=await f.invest('100');await f.fill(sold);
  await f.instructions.close(sold,['VTI']);
  expect(f.liquidations.at(-1)).toMatchObject({allocationId:sold,input:{kind:'liquidate',symbols:['VTI']}});
  expect((await f.db.query(`SELECT status FROM strategy_allocation_closures WHERE allocation_id=$1`,[sold])).rows).toEqual([{status:'selling'}]);
  expect(await authorResult(()=>f.instructions.close(sold,'all'))).toMatchObject({ok:false,code:'closure_settled'});
  const exit=(await f.db.query<{id:string}>(`SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='exit'`,[sold])).rows[0]!.id;
  await f.db.query(`UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE id=$1`,[exit]);
  f.later(1000);
  const legId=await f.leg(sold,'submitted',{kind:'liquidate',transactionId:exit});
  expect(await f.instructions.settleClosures()).toEqual({sold:0,failed:0});
  expect((await f.instructions.holdings()).holdings).toMatchObject([{bucket:{id:sold},closure:{status:'selling'}}]);
  await f.db.query(`UPDATE strategy_executions SET status='filled' WHERE id=$1`,[legId]);
  expect(await f.instructions.settleClosures()).toEqual({sold:1,failed:0});
  expect((await f.db.query(`SELECT status FROM strategy_allocations WHERE id=$1`,[sold])).rows).toEqual([{status:'detached'}]);
  // FollowPanel renders its investment form when there is no active holding.
  expect((await f.instructions.holdings()).holdings).toEqual([]);
  const reinvested=await f.invest('100');
  expect(reinvested).not.toBe(sold);
  expect(reinvested).not.toBe(held);
  expect((await f.instructions.holdings()).holdings).toMatchObject([{bucket:{id:reinvested,status:'active'},closure:null}]);
 }finally{await f.close();}
});

test('keeping after an outside sale takes the shortfall off the claim and follows again',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');await f.fill(id);
  // The member sold 18 of the account's 20 shares outside Opentake; the allocation claims 5.
  await f.resync('2');
  await f.db.transaction(tx=>reconcile(tx,f.account,'VTI',new Date(Date.parse('2026-10-05T15:00:01Z')).toISOString()));
  expect((await f.db.query(`SELECT status FROM strategy_allocations WHERE id=$1`,[id])).rows).toEqual([{status:'diverged'}]);
  const holding=(await f.instructions.holdings()).holdings[0] as {outsideSale:{symbol:string;strategyShares:string}|null};
  expect(holding.outsideSale).toMatchObject({symbol:'VTI',strategyShares:'3'});
  const resolved=await f.instructions.resolveOutsideSale(id,'keep');
  expect(resolved).toMatchObject({caseStatus:'resolved'});
  expect((await f.db.query(`SELECT status FROM strategy_allocations WHERE id=$1`,[id])).rows).toEqual([{status:'active'}]);
  expect(await authorResult(()=>f.instructions.resolveOutsideSale(id,'keep'))).toMatchObject({ok:false,code:'no_open_case'});
 }finally{await f.close();}
});

test('turning confirmations off releases allocations held for an OK; held orders show as awaiting',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');
  await f.instructions.setTradingPreferences({confirmTrades:true});
  const transactionId=(await f.db.query<{id:string}>(`SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1`,[id])).rows[0]!.id;
  await f.db.query(`UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE id=$1`,[transactionId]);
  await f.leg(id,'queued',{transactionId});
  await f.db.query(`UPDATE strategy_allocations SET planning_reason_code='awaiting_confirmation' WHERE id=$1`,[id]);
  expect((await f.instructions.instructions(id)).instructions[0]).toMatchObject({waitingFor:'awaiting_confirmation'});
  const queue=await f.instructions.queueList();
  expect(queue[0]).toMatchObject({state:'needs_you',actions:['confirm','cancel']});
  expect(await f.instructions.tradingPreferences()).toEqual({confirmTrades:true,blockedSymbols:[]});
  await f.instructions.setTradingPreferences({confirmTrades:false});
  expect((await f.db.query(`SELECT planning_reason_code FROM strategy_allocations WHERE id=$1`,[id])).rows).toEqual([{planning_reason_code:null}]);
  // The queue's Confirm on a bucket's orders lifts the hold and places.
  await f.instructions.queueAct(`strategy:orders:${id}:bucket:${id}`,'confirm');
  expect(f.executed.at(-1)).toBe(id);
 }finally{await f.close();}
});

test('archiving a take with money in it asks to hold or sell; unarchiving withdraws the question; a failed close can be retried',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');await f.fill(id);
  const queued=await f.leg(id,'queued');
  const closure=async()=>(await f.db.query<{reason:string;status:string;failure_code:string|null}>(`SELECT reason,status,failure_code FROM strategy_allocation_closures WHERE allocation_id=$1`,[id])).rows;
  await f.db.query(`UPDATE strategies SET archived_at=now() WHERE id=$1`,[f.strategy]);
  expect(await closure()).toEqual([{reason:'archive',status:'awaiting',failure_code:null}]);
  expect((await f.db.query(`SELECT status,failure_code FROM strategy_executions WHERE id=$1`,[queued])).rows).toEqual([{status:'cancelled',failure_code:'archived'}]);
  expect((await f.db.query(`SELECT planning_reason_code FROM strategy_allocations WHERE id=$1`,[id])).rows).toEqual([{planning_reason_code:'strategy_archived'}]);
  expect(((await f.instructions.holdings()).holdings[0] as {closure:unknown}).closure).toMatchObject({reason:'archive',status:'awaiting',sellSymbols:null,failureCode:null});

  await f.db.query(`UPDATE strategies SET archived_at=NULL WHERE id=$1`,[f.strategy]);
  expect(await closure()).toEqual([]);
  expect((await f.db.query(`SELECT planning_reason_code FROM strategy_allocations WHERE id=$1`,[id])).rows).toEqual([{planning_reason_code:null}]);

  // Archived again: a sell that cannot be planned fails with its reason, and the same choice can be retried.
  await f.db.query(`UPDATE strategies SET archived_at=now() WHERE id=$1`,[f.strategy]);
  f.setDisposition('failed');
  await f.instructions.close(id,['VTI']);
  expect(await closure()).toEqual([{reason:'archive',status:'failed',failure_code:'market_closed'}]);
  expect(((await f.instructions.holdings()).holdings[0] as {closure:unknown}).closure).toMatchObject({status:'failed',sellSymbols:['VTI'],failureCode:'market_closed'});
  f.setDisposition('planned');
  await f.instructions.close(id,['VTI']);
  expect(await closure()).toEqual([{reason:'archive',status:'selling',failure_code:null}]);
  // A close already under way is left alone by unarchiving.
  await f.db.query(`UPDATE strategies SET archived_at=NULL WHERE id=$1`,[f.strategy]);
  expect(await closure()).toEqual([{reason:'archive',status:'selling',failure_code:null}]);
 }finally{await f.close();}
});

test('holdings carry the panel’s live fields',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');await f.fill(id);
  await f.leg(id,'failed',{failureCode:'provider_invalid_request',createdAt:'2026-10-05T14:00:00Z'});
  await f.leg(id,'queued');
  await f.db.query(`UPDATE strategy_allocations SET planning_reason_code='market_closed',planning_deferred_until='2026-10-06T13:30:00Z' WHERE id=$1`,[id]);
  const holding=(await f.instructions.holdings()).holdings[0] as Record<string,unknown>;
  expect(holding).toMatchObject({
   bucket:{id,status:'active'},strategy:{id:f.strategy,displayName:'Fixture basket'},allocation:{weights:[{symbol:'VTI',weightPercent:80}],cashPercent:20},
   valuation:{complete:true,totalValue:'100'},positions:[{symbol:'VTI',quantity:'5',markPrice:'10',value:'50'}],
   openExecutions:1,ordersOpenAt:'2026-10-06T13:30:00.000Z',waiting:{reason:'market_closed'},
   lastFailure:null,outsideSale:null,outsideCash:null,closure:null,requiresReconciliation:false,
  });
  expect((holding.pnl as {capitalAllocated:string}).capitalAllocated).toBe('100');
  // As hosted: the strategy's unrealized is the sum of its positions' (value minus cost).
  const positions=holding.positions as {value:string;costBasis:string;unrealized:string}[];
  expect(positions.every(p=>Number(p.unrealized)===Number(p.value)-Number(p.costBasis))).toBe(true);
  expect(Number((holding.pnl as {unrealized:string}).unrealized)).toBe(positions.reduce((n,p)=>n+Number(p.unrealized),0));
  expect(replicationState({targetSymbols:['A','B'],heldSymbols:['A'],inFlightSymbols:[],skippedSymbols:[],everSynchronized:true})).toEqual({state:'replication_limited',missingSymbols:['B']});
  const preflight=await f.instructions.preflight({bucketId:id},'50');
  expect(preflight).toMatchObject({kind:'contribution',amount:'50'});
  const activity=await f.instructions.activity(f.strategy);
  expect(activity.events.map(e=>(e as {kind:string}).kind)).toContain('invested');
 }finally{await f.close();}
});

test('an order of unknown outcome is cleared only by the member, and a late Robinhood match still finds it',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');
  const legId=await f.leg(id,'placement_unknown');
  const intent=randomUUID(),refId=randomUUID();
  const transaction=(await f.db.query<{id:string}>(`SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 ORDER BY sequence LIMIT 1`,[id])).rows[0]!.id;
  await f.db.query(`INSERT INTO order_intents(id,account_id,allocation_id,transaction_id,asset_class,status,ref_id,order_request,review_result,reviewed_at,expires_at,updated_at)
   VALUES($1,$2,$3,$5,'equity','placement_unknown',$4,'{}','{}',now(),now(),now())`,[intent,f.account,id,refId,transaction]);
  await f.db.query(`UPDATE strategy_executions SET order_intent_id=$2 WHERE id=$1`,[legId,intent]);
  const holding=(await f.instructions.holdings()).holdings[0] as {unknownOrders:{legId:string;symbol:string;side:string}[]};
  expect(holding.unknownOrders).toMatchObject([{legId,symbol:'VTI',side:'buy'}]);
  await f.instructions.abandonUnknownOrder(id,legId);
  expect((await f.db.query(`SELECT status,failure_code FROM strategy_executions WHERE id=$1`,[legId])).rows).toEqual([{status:'cancelled',failure_code:'member_abandoned'}]);
  expect((await f.db.query(`SELECT status FROM order_intents WHERE id=$1`,[intent])).rows).toEqual([{status:'abandoned'}]);
  await expect(f.instructions.abandonUnknownOrder(id,legId)).rejects.toThrow('no longer of unknown outcome');
  // The member was wrong: the order shows up on a sync, and is matched (its fills then go to this strategy).
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','rh-late','equity','filled',true,$2,now(),now())`,[f.account,JSON.stringify({clientRef:refId})]);
  const {createOrderWriter}=await import('../../../src/main/orders/service');
  const writer=createOrderWriter({use:fn=>fn(f.db)} as never,{equityOrder:async()=>({})},{enabled:()=>true});
  expect(await writer.reconcile(f.account)).toBe(1);
  expect((await f.db.query(`SELECT status,provider_order_ref FROM order_intents WHERE id=$1`,[intent])).rows).toEqual([{status:'placed',provider_order_ref:'rh-late'}]);
  // Once Robinhood has an id for it, it can no longer be cleared.
  const second=await f.leg(id,'placement_unknown'),known=randomUUID();
  await f.db.query(`INSERT INTO order_intents(id,account_id,allocation_id,transaction_id,asset_class,status,ref_id,order_request,review_result,reviewed_at,expires_at,updated_at,provider_order_ref)
   VALUES($1,$2,$3,$4,'equity','placement_unknown',$5,'{}','{}',now(),now(),now(),'rh-known')`,[known,f.account,id,transaction,randomUUID()]);
  await f.db.query(`UPDATE strategy_executions SET order_intent_id=$2 WHERE id=$1`,[second,known]);
  await expect(f.instructions.abandonUnknownOrder(id,second)).rejects.toThrow('Robinhood has this order');
 }finally{await f.close();}
});

test('a withdrawal whose sells Robinhood refused fails instead of staying open (live 2026-10-05)',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');await f.fill(id);
  const redemption=await f.db.transaction(tx=>instruction(tx,{allocationId:id,kind:'redemption',cause:randomUUID(),requestedAmount:'2'},new Date().toISOString()));
  await f.leg(id,'failed',{transactionId:redemption,kind:'redeem',failureCode:'provider_invalid_request'});
  await f.instructions.settleRedemptions();
  expect((await f.db.query(`SELECT outcome,outcome_code FROM strategy_allocation_transactions WHERE id=$1`,[redemption])).rows).toEqual([{outcome:'failed',outcome_code:'provider_invalid_request'}]);
  // Nothing was released: the money stays invested.
  expect((await f.db.query(`SELECT count(*)::int n FROM strategy_attribution_entries WHERE transaction_id=$1 AND entry_type='capital_released'`,[redemption])).rows).toEqual([{n:0}]);
 }finally{await f.close();}
});

test('Coinbase and mixed-platform Takes cannot reserve Robinhood cash or reach execution', async()=>{
 const f=await fixture({mixed:true});try{
  await expect(f.invest()).rejects.toThrow('mixed-platform');
  expect(f.plans).toEqual([]);expect(f.executed).toEqual([]);
  expect((await f.db.query('SELECT id FROM strategy_allocations')).rows).toEqual([]);
 }finally{await f.close();}
});

test('preparation failure returns Robinhood investment cash and a failed deposit preserves earlier capital',async()=>{
 const f=await fixture();try{
  const initial=await f.invest('100');f.setDisposition('failed');
  expect(await authorResult(()=>f.instructions.update(initial,{status:'active'}))).toMatchObject({ok:false,code:'preparation_failed'});
  const first=(await f.db.query<{outcome:string}>("SELECT outcome FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='investment'",[initial])).rows[0];
  expect(first.outcome).toBe('cancelled');
  expect(Number((await f.db.query<{cash:string}>('SELECT sum(cash_delta)::text AS cash FROM strategy_attribution_entries WHERE allocation_id=$1',[initial])).rows[0].cash)).toBe(0);
  f.setDisposition('planned');const existing=await f.invest('100');await f.fill(existing);
  const before=(await f.db.query<{cash:string}>('SELECT sum(cash_delta)::text AS cash FROM strategy_attribution_entries WHERE allocation_id=$1',[existing])).rows[0].cash;
  f.setDisposition('failed');expect(await authorResult(()=>f.instructions.deposit(existing,'50'))).toMatchObject({ok:false,code:'preparation_failed'});
  expect((await f.db.query<{cash:string}>('SELECT sum(cash_delta)::text AS cash FROM strategy_attribution_entries WHERE allocation_id=$1',[existing])).rows[0].cash).toBe(before);
  expect(Number((await f.db.query<{value:string}>('SELECT allocation_value::text AS value FROM strategy_allocations WHERE id=$1',[existing])).rows[0].value)).toBe(100);
  const contribution=(await f.db.query<{id:string}>("SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='contribution'",[existing])).rows[0];
  await f.instructions.cancelInstruction(existing,contribution.id);
  expect((await f.db.query("SELECT * FROM strategy_attribution_entries WHERE allocation_id=$1 AND entry_type='capital_released'",[existing])).rows).toHaveLength(1);
 }finally{await f.close();}
});

test('Take activity includes scoped Coinbase capital, deposits, withdrawals and returned funds with their currencies',async()=>{
 const f=await fixture();try{
  const allocation=randomUUID();
  const connection=(await f.db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','synthetic-activity' FROM local_owners RETURNING id")).rows[0].id;
  const account=(await f.db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,selected,agentic_allowed) VALUES($1,'synthetic','Test',false,false) RETURNING id",[connection])).rows[0].id;
  await f.db.query(`INSERT INTO coinbase_allocations(id,account_id,strategy_id,version_id,created_at)
   SELECT $1,$2,id,current_version_id,now() FROM strategies WHERE id=$3`,[allocation,account,f.strategy]);
  for(const [i,kind,quantity,asset,cause] of [[0,'capital','10','USDC','capital:first'],[1,'capital','5','USD','capital:second'],[2,'release','-2','USDC','withdrawal-return:test'],[3,'release','-1','USD','investment-return:test:1'],[4,'release','0','USD','investment-return:test:0']] as const){
   await f.db.query(`INSERT INTO coinbase_allocation_entries(id,allocation_id,account_id,asset,quantity,cause,request_hash,kind,occurred_at) VALUES($1,$2,$3,$4,$5,$6,'synthetic',$7,$8)`,[randomUUID(),allocation,account,asset,quantity,cause,kind,`2026-10-06T13:30:0${i}Z`]);
  }
  const page=await f.instructions.activity(f.strategy,2);
  expect(page.events).toMatchObject([{kind:'returned',amount:expect.any(String),currency:'USD'},{kind:'withdrawn',currency:'USDC'}]);
  expect(Number(page.events[0].amount)).toBe(1);
  const older=await f.instructions.activity(f.strategy,2,page.nextCursor);
  expect(older.events).toMatchObject([{kind:'deposit',currency:'USD'},{kind:'invested',currency:'USDC'}]);
  expect((await f.instructions.activity(randomUUID())).events).toEqual([]);
  const take=randomUUID();
  await f.db.query(`INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Synthetic','{}',$2 FROM local_owners`,[take,f.strategy]);
  for(const [i,trigger] of ['drift','schedule'].entries()){
   const review=randomUUID();
   await f.db.query(`INSERT INTO coinbase_order_reviews(id,take_id,account_id,allocation_id,version_id,authority,claims_hash,payload,created_at,expires_at) SELECT $1,$2,$3,$4,current_version_id,'synthetic','synthetic','{}',now(),now() FROM strategies WHERE id=$5`,[review,take,account,allocation,f.strategy]);
   await f.db.query(`INSERT INTO coinbase_rebalance_runs(id,allocation_id,scheduled_on,review_id,state,trigger,next_attempt_at,created_at,updated_at) VALUES($1,$2,$3,$4,'completed',$5,now(),now(),$6)`,[randomUUID(),allocation,`2026-10-0${7+i}`,review,trigger,`2026-10-0${7+i}T13:00:00Z`]);
  }
  expect((await f.instructions.activity(f.strategy)).events.filter(e=>e.kind==='rebalance').map(e=>e.detail)).toEqual(['schedule','drift']);

 }finally{await f.close();}
});


test('Robinhood deposit receipts wait for fills, deduplicate and exclude cancelled contributions',async()=>{
 const {syncCapitalNotifications}=await import('../../../src/main/trading/capital-notifications');
 const f=await fixture();try{
  const id=await f.invest('100');
  await f.instructions.deposit(id,'50');
  await syncCapitalNotifications(f.db);
  expect((await f.db.query("SELECT * FROM notifications WHERE payload->>'kind'='capital_update'")).rows).toHaveLength(0);
  const transaction=(await f.db.query<{id:string}>("SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='contribution'",[id])).rows[0].id;
  await f.leg(id,'filled',{transactionId:transaction});
  await syncCapitalNotifications(f.db);await syncCapitalNotifications(f.db);
  expect((await f.db.query<{payload:{title:string}}>("SELECT payload FROM notifications WHERE payload->>'kind'='capital_update'")).rows.map(r=>r.payload.title)).toEqual(['Deposited $50.00']);
  await f.instructions.deposit(id,'20');
  const next=(await f.db.query<{id:string}>("SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='contribution' ORDER BY sequence DESC LIMIT 1",[id])).rows[0].id;
  await f.instructions.cancelInstruction(id,next);await syncCapitalNotifications(f.db);
  expect((await f.db.query("SELECT * FROM notifications WHERE payload->>'kind'='capital_update'")).rows).toHaveLength(1);
 }finally{await f.close();}
});

test('crypto closure keeps remaining units attributed instead of reporting them sold',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');await f.fill(id);
  const ref=JSON.stringify(['robinhood','production','btc','crypto',null,null]);
  const at='2026-10-05T15:00:00.000Z';
  const original=(await f.db.query<{id:string}>("SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='investment'",[id])).rows[0].id;
  await f.db.transaction(tx=>append(tx,{allocationId:id,transactionId:original,entryType:'fill',instrumentRef:ref,assetClass:'crypto',symbol:'BTC-USD',quantityDelta:'0.001',cashDelta:'0',cause:'synthetic-crypto',sourceKind:'test',sourceRef:'test',occurredAt:at},at));
  await f.instructions.close(id,['BTC-USD']);
  const exit=(await f.db.query<{id:string}>(`SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='exit'`,[id])).rows[0].id;
  await f.db.query('UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE id=$1',[exit]);
  f.later(1000);await f.leg(id,'filled',{kind:'liquidate',transactionId:exit});
  expect(await f.instructions.settleClosures()).toEqual({sold:0,failed:1});
  expect((await f.db.query('SELECT status,failure_code FROM strategy_allocation_closures WHERE allocation_id=$1',[id])).rows[0]).toEqual({status:'failed',failure_code:'crypto_units_remaining'});
  expect((await f.db.query<{quantity:string}>('SELECT sum(quantity_delta)::text AS quantity FROM strategy_attribution_entries WHERE allocation_id=$1 AND instrument_ref=$2',[id,ref])).rows[0].quantity).toBe('0.001000000000000000');
 }finally{await f.close();}
});

test('due instructions follow the basket calendar on weekends',async()=>{
 const f=await fixture();try{
  const id=await f.invest('100');
  await f.db.query("UPDATE strategy_allocation_transactions SET pending_reason='requested' WHERE allocation_id=$1",[id]);
  await f.db.query('UPDATE strategy_allocations SET planning_deferred_until=NULL WHERE id=$1',[id]);
  f.later(5*86400000);
  expect(await f.instructions.dueInstructions()).toEqual([]);
  const instrument={venue:'robinhood',symbol:'BTC-USD',market:{venue:'robinhood',instance:'production',reference:'btc',kind:'crypto'}};
  const next=randomUUID();
  await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification)
   SELECT $3,strategy_id,owner_id,sequence+1,schema_version,metadata,jsonb_set(spec,'{target,weights,0,instrument}',$2::jsonb),provenance,verification FROM strategy_versions WHERE id=(SELECT accepted_version_id FROM strategy_allocations WHERE id=$1)`,[id,JSON.stringify(instrument),next]);
  await f.db.query('UPDATE strategy_allocations SET accepted_version_id=$2 WHERE id=$1',[id,next]);
  expect(await f.instructions.dueInstructions()).toMatchObject([{allocationId:id}]);
  const transaction=(await f.db.query<{id:string}>('SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND pending_reason IS NOT NULL',[id])).rows[0].id;
  await f.db.query("UPDATE strategy_allocation_transactions SET pending_reason='market_closed' WHERE id=$1",[transaction]);
  expect((await f.instructions.instructions(id)).instructions[0]).toMatchObject({waitingFor:'requested',expectedAt:null});
  await f.db.query('UPDATE strategy_allocation_transactions SET pending_reason=NULL WHERE id=$1',[transaction]);
  const leg=await f.leg(id,'queued',{transactionId:transaction});
  await f.db.query('UPDATE strategy_executions SET version_id=$2 WHERE id=$1',[leg,next]);
  expect((await f.instructions.instructions(id)).instructions[0]).toMatchObject({waitingFor:null,expectedAt:null});
  // A later crypto target cannot relabel an older queued equity basket as 24/7.
  await f.db.query('UPDATE strategy_executions SET version_id=(SELECT applied_version_id FROM strategy_allocations WHERE id=$2) WHERE id=$1',[leg,id]);
  expect((await f.instructions.instructions(id)).instructions[0]).toMatchObject({waitingFor:'market_closed',expectedAt:expect.any(String)});
  await f.db.query('UPDATE strategy_executions SET transaction_id=NULL,version_id=$2 WHERE id=$1',[leg,next]);
  await f.db.query("UPDATE strategy_allocations SET planning_reason_code='market_closed' WHERE id=$1",[id]);
  const cryptoQueue=(await f.instructions.queueList()).find(item=>item.id.startsWith('strategy:orders:'));
  expect(cryptoQueue).toMatchObject({reason:null,expectedAt:null});
  await f.db.query('UPDATE strategy_executions SET version_id=(SELECT applied_version_id FROM strategy_allocations WHERE id=$2) WHERE id=$1',[leg,id]);
  const equityQueue=(await f.instructions.queueList()).find(item=>item.id.startsWith('strategy:orders:'));
  expect(equityQueue).toMatchObject({reason:'market_closed',expectedAt:expect.any(String)});


 }finally{await f.close();}
});


test('Take crypto activation checks fail closed before funding and skip equity fractional rules',async()=>{
 const checks=['Account active','Pair available for trading','Selected account type permits this side','No applicable trading halt'].map(check=>({check,satisfied:true as boolean|null}));
 const f=await fixture({cryptoRead:()=>({pairId:'btc',symbol:'BTC-USD',side:'buy',checks})});
 try{
  const instruments=[{venue:'robinhood' as const,symbol:'BTC-USD',market:{venue:'robinhood' as const,instance:'production',reference:'btc',kind:'crypto' as const}}];
  await expect(f.instructions.checkTradability(f.account,['BTC-USD'],instruments)).resolves.toBeUndefined();
  await expect(f.instructions.checkTradability(f.account,['UNKNOWN'],instruments)).rejects.toMatchObject({code:'tradability_check_unavailable'});
  checks[3].satisfied=null;
  await expect(f.instructions.checkTradability(f.account,['BTC-USD'],instruments)).rejects.toMatchObject({code:'tradability_check_unavailable'});
  checks[3].satisfied=false;
  await expect(f.instructions.checkTradability(f.account,['BTC-USD'],instruments)).rejects.toMatchObject({code:'symbol_not_tradable'});
  expect((await f.db.query('SELECT id FROM strategy_allocations')).rows).toHaveLength(0);
 }finally{await f.close();}
});

test('a rule trade the member approved plans and places with that approval, so it is not held again',async()=>{
 const f=await fixture();const id=await f.invest();await f.db.query("UPDATE strategy_allocations SET status='active' WHERE id=$1",[id]);
 f.confirmations.length=0;
 await f.instructions.plan(id,true);expect(f.confirmations.at(-1)).toBe(true);
 await f.instructions.plan(id);expect(f.confirmations.at(-1)).toBe(false);
});
