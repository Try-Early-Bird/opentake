import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID,createHash} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {importStrategyPortfolio} from '../../../src/main/allocations/portfolio-import';
import {createAllocationResume} from '../../../src/main/allocations/resume';
import {append,instruction} from '../../../src/main/allocations/ledger';
import {openCase} from '../../../src/main/allocations/reconciliation';

async function fixture(){
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=Date.parse('2026-10-03T14:00:00Z'),shares='20';
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const accountId=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic-hash','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:accountId,selected:true,agenticAllowed:true,maskedNumber:'fixture',nickname:null,accountType:'cash'}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'1200',cash:'1000',buying_power:'1000'}:name==='get_equity_positions'?{results:[{instrument_id:'VTI',symbol:'VTI',quantity:shares,mark_price:'10',average_buy_price:'8'}]}:{results:[]},
 },()=>now);
 await sync.synchronize();
 const sourceConnection=randomUUID(),sourceStrategy=randomUUID();
 const input={format:'opentake-strategy-portfolio-v1',exportedAt:new Date(now).toISOString(),source:{branch:'development',provider:'robinhood_agentic',accountId:randomUUID(),connectionId:sourceConnection,accountRefHash:createHash('sha256').update(`${sourceConnection}:synthetic-hash`).digest('hex')},
  strategies:[{id:sourceStrategy,title:'Imported strategy',description:'Synthetic',rebalance:null,versions:[{id:randomUUID(),sequence:1,weights:[{symbol:'VTI',weightPercent:80}],cashPercent:20}]}],
  allocations:[{id:randomUUID(),strategyId:sourceStrategy,status:'active',appliedSequence:1,entries:[
   {id:randomUUID(),sequence:1,entryType:'capital_allocated',symbol:null,quantityDelta:null,cashDelta:'100',unitCost:null,currency:'USD',sourceKind:'reconciliation',sourceRef:'fixture1',occurredAt:'2026-10-01T14:00:00Z'},
   {id:randomUUID(),sequence:2,entryType:'fill',symbol:'VTI',quantityDelta:'5',cashDelta:'-50',unitCost:'10',currency:'USD',sourceKind:'strategy_execution',sourceRef:'fixture2',occurredAt:'2026-10-02T15:00:00Z'},
  ],history:[]}]};
 await importStrategyPortfolio(database,input,undefined,now,{externalRef:'synthetic-hash',connectionId:sourceConnection,accountRefHash:input.source.accountRefHash});
 const allocationId=(await sync.snapshot()).strategies![0].allocationId;
 const resume=createAllocationResume(database,()=>now);
 const row=async()=>(await db.query<{status:string;restore_required:boolean}>('SELECT status,restore_required FROM strategy_allocations WHERE id=$1',[allocationId])).rows[0];
 return {db,sync,accountId,allocationId,resume,row,now:()=>new Date(now).toISOString(),
  resync:async(next:string)=>{shares=next;now+=1000;await sync.synchronize();},
  later:(ms:number)=>{now+=ms;},close:async()=>{sync.cancel();await db.close();}};
}

test('a clean imported allocation reviews ready and resumes, settling the import instruction',async()=>{
 const f=await fixture();try{
  const review=await f.resume.review(f.allocationId);
  expect(review).toMatchObject({status:'paused',restoreRequired:true,pauseReason:'imported',ready:true,cases:[],blockers:[],
   positions:[{symbol:'VTI',claimed:'5',available:'20'}],cash:{claimed:'50',available:'1000'}});
  const resumed=await f.resume.resume(f.allocationId);
  expect(resumed).toMatchObject({status:'active',restoreRequired:false,pauseReason:null});
  expect(await f.row()).toEqual({status:'active',restore_required:false});
  expect((await f.db.query(`SELECT pending_reason FROM strategy_allocation_transactions WHERE allocation_id=$1 AND kind='reconciliation'`,[f.allocationId])).rows).toEqual([{pending_reason:null}]);
  // Member pause and resume after the fence is lifted.
  expect(await f.resume.pause(f.allocationId)).toMatchObject({status:'paused',pauseReason:'paused_by_you'});
  expect((await f.resume.resume(f.allocationId)).status).toBe('active');
  await expect(f.resume.pause(randomUUID())).rejects.toThrow('Allocation not found');
 }finally{await f.close();}
});

test('a shortfall opens a case that blocks resume until the reduced claim is kept',async()=>{
 const f=await fixture();try{
  // Shares sold outside the app: the account now holds 2, the allocation claims 5.
  await f.resync('2');
  const review=await f.resume.review(f.allocationId);
  expect(review.ready).toBe(false);
  expect(review.cases).toMatchObject([{cause:'position_shortfall',symbol:'VTI',claimed:'5',observed:'2',canKeepReduced:true}]);
  await expect(f.resume.resume(f.allocationId)).rejects.toThrow('Resolve the differences before resuming');
  const kept=await f.resume.keepReduced(f.allocationId,review.cases[0]!.id);
  expect(kept).toMatchObject({ready:true,cases:[],positions:[{symbol:'VTI',claimed:'2'}]});
  expect((await f.resume.resume(f.allocationId)).status).toBe('active');
 }finally{await f.close();}
});

test('stale evidence and unsettled fills block the review instead of guessing',async()=>{
 const f=await fixture();try{
  f.later(16*60_000);
  const stale=await f.resume.review(f.allocationId);
  expect(stale).toMatchObject({ready:false,blockers:['evidence_stale']});
  await expect(f.resume.resume(f.allocationId)).rejects.toThrow('Sync the account before resuming');
  await f.resync('20');
  expect((await f.resume.review(f.allocationId)).ready).toBe(true);
  // A synced fill the attribution sweep has not settled yet.
  const at=f.now(),data={quantity:'1',price:'10',feeAmount:null,notionalAmount:null,side:'buy',instrumentRef:'VTI',symbol:'VTI',origin:'user',orderCreatedAt:at,occurredAt:at};
  await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood','pending-fill','equity','filled',true,'{}',$2,$2)`,[f.accountId,at]);
  await f.db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood','pending-fill','pending-fill','equity',$2,$3)`,[f.accountId,JSON.stringify(data),at]);
  expect(await f.resume.review(f.allocationId)).toMatchObject({ready:false,blockers:['fills_pending']});
 }finally{await f.close();}
});

test('a take that spent more cash than it held is covered as money the member put in, with nothing traded (hosted operator correction)',async()=>{
 const f=await fixture();try{
  await f.resume.resume(f.allocationId);
  const value=async()=>(await f.db.query<{v:string}>(`SELECT allocation_value::text AS v FROM strategy_allocations WHERE id=$1`,[f.allocationId])).rows[0]!.v;
  const before=Number(await value());
  // A $50.80 buy filled against the $50 the take held: $0.80 came from the member's own cash.
  const caseId=await f.db.transaction(async tx=>{
   const transactionId=await instruction(tx,{allocationId:f.allocationId,kind:'rebalance',cause:'overspend'},f.now());
   await append(tx,{allocationId:f.allocationId,transactionId,entryType:'fill',instrumentRef:'VTI',symbol:'VTI',quantityDelta:'5.08',cashDelta:'-50.8',unitCost:'10',
    cause:'overspend:fill',sourceKind:'provider_execution',sourceRef:'synthetic-fill',occurredAt:f.now()},f.now());
   return openCase(tx,{accountId:f.accountId,scope:`ledger:${f.allocationId}`,cause:'negative_subledger_balance',impacts:[{allocationId:f.allocationId,quantity:'0'}],evidence:{}},f.now());
  });
  expect(await f.row()).toMatchObject({status:'diverged'});
  const review=await f.resume.review(f.allocationId);
  expect(review.cases).toMatchObject([{id:caseId,cause:'negative_subledger_balance',claimed:'-0.8',difference:'0.8',canCover:true,canKeepReduced:false,oversold:[]}]);
  const covered=await f.resume.coverShortfall(f.allocationId,caseId);
  expect(covered).toMatchObject({status:'active',cases:[],cash:{claimed:'0'}});
  expect(Number(await value())).toBeCloseTo(before+0.8,6);
  expect((await f.db.query(`SELECT entry_type,cash_delta::numeric(20,2)::text AS cash,source_kind,metadata->>'correction' AS correction FROM strategy_attribution_entries WHERE source_kind='member_correction'`)).rows)
   .toEqual([{entry_type:'capital_allocated',cash:'0.80',source_kind:'member_correction',correction:'true'}]);
  expect((await f.db.query(`SELECT resolution FROM strategy_reconciliation_cases WHERE id=$1`,[caseId])).rows).toEqual([{resolution:'member_capital'}]);
  await expect(f.resume.coverShortfall(f.allocationId,caseId)).rejects.toThrow('There is no shortfall to cover');
 }finally{await f.close();}
});

test('a take that sold shares it did not hold cannot be covered with cash',async()=>{
 const f=await fixture();try{
  await f.resume.resume(f.allocationId);
  const caseId=await f.db.transaction(async tx=>{
   const transactionId=await instruction(tx,{allocationId:f.allocationId,kind:'redemption',cause:'oversell'},f.now());
   await append(tx,{allocationId:f.allocationId,transactionId,entryType:'fill',instrumentRef:'VTI',symbol:'VTI',quantityDelta:'-6',cashDelta:'60',unitCost:'10',
    cause:'oversell:fill',sourceKind:'provider_execution',sourceRef:'synthetic-sell',occurredAt:f.now()},f.now());
   return openCase(tx,{accountId:f.accountId,scope:`ledger:${f.allocationId}`,cause:'negative_subledger_balance',impacts:[{allocationId:f.allocationId,quantity:'0'}],evidence:{}},f.now());
  });
  expect((await f.resume.review(f.allocationId)).cases).toMatchObject([{canCover:false,oversold:[{symbol:'VTI',quantity:'1'}]}]);
  await expect(f.resume.coverShortfall(f.allocationId,caseId)).rejects.toThrow('close it instead');
 }finally{await f.close();}
});
