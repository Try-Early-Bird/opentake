import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createAllocationCore} from '../../../src/main/allocations/service';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {deriveAllocationPnl} from '../../../src/main/allocations/allocation-pnl';
import {equityRef} from '../../../src/main/allocations/evidence';
import {instruction,append} from '../../../src/main/allocations/ledger';
import {rekeyEquityClaims} from '../../../src/main/allocations/rekey';
import {createAttributionSweep} from '../../../src/main/allocations/attribution-sweep';

// Live finding 2026-10-05: Robinhood positions carry only the ticker, fills carry an
// instrument id. Claims meet both on the ticker; claims recorded under an id are
// reversed and re-recorded (append-only), and a reinvestment that credited nobody
// is attributed again.
const at=Date.parse('2026-10-05T14:00:00Z');

async function fixture(){
 const db=new PGlite();await migrate(db);
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 let now=at,qdte='2';
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'x','fixture',true,true) RETURNING id`,[connection])).rows[0].id;
 // Robinhood's live positions reply: symbol only, no instrument id.
 const sync=createAccountSync(database as Parameters<typeof createAccountSync>[0],{
  status:async()=>({status:'connected',checkedAt:null,accounts:[{id:account,maskedNumber:'fixture',nickname:null,accountType:'cash',agenticAllowed:true,selected:true}]}),
  readTool:async(name:string)=>name==='get_portfolio'?{total_value:'100',cash:'40',buying_power:'40'}:name==='get_equity_positions'?{data:{positions:[{symbol:'SPY',quantity:'0.006492',type:'long'},{symbol:'QDTE',quantity:qdte,type:'long'}]}}:{results:[]},
 } as never,()=>now);
 await sync.synchronize();
 const strategy=randomUUID(),version=randomUUID();
 await db.query(`INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners`,[strategy]);
 await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{"schemaVersion":1,"kind":"basket","target":{"weights":[{"instrument":{"venue":"robinhood","symbol":"SPY"},"bps":5000},{"instrument":{"venue":"robinhood","symbol":"QDTE"},"bps":5000}],"cashBps":0},"rebalance":{"schedule":"never","driftBandPoints":null,"driftBandRelative":null}}','{}','{}' FROM local_owners`,[version,strategy]);
 await db.query(`UPDATE strategies SET status='committed',current_version_id=$2 WHERE id=$1`,[strategy,version]);
 const core=createAllocationCore(database,()=>now);
 const spy=await core.invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'5',cause:randomUUID()});
 const qdteAllocation=await core.invest({allocationId:randomUUID(),accountId:account,strategyId:strategy,versionId:version,amount:'1',cause:randomUUID()});
 return {db,database,core,account,spy,qdteAllocation,clock:()=>now,later:(ms:number)=>{now+=ms;},setQdte:(q:string)=>{qdte=q;},resync:async()=>{now+=1000;await sync.synchronize();},close:async()=>{sync.cancel();await db.close();}};
}
const fill=async(f:Awaited<ReturnType<typeof fixture>>,ref:string,data:Record<string,unknown>)=>{
 const t=new Date(f.clock()).toISOString();
 await f.db.query(`INSERT INTO account_orders(account_id,provider,provider_ref,asset_class,state,terminal,data,first_seen,last_seen) VALUES($1,'robinhood',$2,'equity','filled',true,'{}',$3,$3)`,[f.account,ref,t]);
 await f.db.query(`INSERT INTO account_executions(account_id,provider,provider_ref,order_ref,asset_class,data,occurred_at) VALUES($1,'robinhood',$2,$2,'equity',$3,$4)`,
  [f.account,ref,JSON.stringify({feeAmount:null,notionalAmount:null,orderCreatedAt:t,occurredAt:t,...data}),t]);
};

test('a fill is keyed by its ticker, and an id-keyed claim is reversed and re-recorded with unchanged money',async()=>{
 const f=await fixture();try{
  expect(equityRef({symbol:'spy',instrumentRef:'8f92e76f'})).toBe('SPY');
  expect(equityRef({symbol:null,instrumentRef:'8f92e76f'})).toBe('8f92e76f');
  // A claim written the old way, under Robinhood's instrument id.
  await f.db.transaction(async tx=>{
   const transactionId=await instruction(tx,{allocationId:f.spy.allocationId,kind:'rebalance',cause:'old-buy'},new Date(f.clock()).toISOString());
   await append(tx,{allocationId:f.spy.allocationId,transactionId,entryType:'fill',instrumentRef:'8f92e76f-1e0e-4478-8580-16a6ffcfaef5',symbol:'SPY',quantityDelta:'0.006492',cashDelta:'-4.9999',unitCost:'770.17',sourceKind:'provider_execution',sourceRef:'old',cause:'old-fill',occurredAt:new Date(f.clock()).toISOString()},new Date(f.clock()).toISOString());
  });
  expect(await rekeyEquityClaims(f.database,f.clock)).toEqual({rekeyed:1,retried:0});
  expect(await rekeyEquityClaims(f.database,f.clock)).toEqual({rekeyed:0,retried:0});
  const rows=(await f.db.query<{sequence:number;entry_type:string;instrument_ref:string|null;symbol:string|null;quantity_delta:string|null;cash_delta:string}>(`SELECT sequence,entry_type,instrument_ref,symbol,quantity_delta::text,cash_delta::text FROM strategy_attribution_entries WHERE allocation_id=$1 ORDER BY sequence`,[f.spy.allocationId])).rows;
  const byKey=new Map<string,number>();for(const r of rows)if(r.instrument_ref)byKey.set(r.instrument_ref,(byKey.get(r.instrument_ref)??0)+Number(r.quantity_delta));
  expect(byKey.get('SPY')).toBeCloseTo(0.006492,9);expect(byKey.get('8f92e76f-1e0e-4478-8580-16a6ffcfaef5')).toBe(0);
  const pnl=deriveAllocationPnl(rows.map(r=>({sequence:r.sequence,entryType:r.entry_type,symbol:r.symbol,quantityDelta:r.quantity_delta,cashDelta:r.cash_delta})));
  expect(pnl.bySymbol.get('SPY')?.quantity).toBe('0.006492');
  // The reversal sells at cost: nothing realized beyond fixed-point rounding.
  expect(Math.abs(Number(pnl.bySymbol.get('SPY')!.realized))).toBeLessThan(1e-12);
  expect(Number(pnl.bySymbol.get('SPY')!.costBasis)).toBeCloseTo(4.9999,6);
 }finally{await f.close();}
});

test('a reinvested dividend reaches the strategy holding its ticker, including one that credited nobody before',async()=>{
 const f=await fixture();try{
  // The QDTE strategy holds the account's 2 shares (an import keyed by ticker).
  await f.db.transaction(async tx=>{
   const transactionId=await instruction(tx,{allocationId:f.qdteAllocation.allocationId,kind:'reconciliation',cause:'import'},new Date(f.clock()).toISOString());
   await append(tx,{allocationId:f.qdteAllocation.allocationId,transactionId,entryType:'external_adjustment',instrumentRef:'QDTE',symbol:'QDTE',quantityDelta:'2',cashDelta:'0',sourceKind:'development_import',sourceRef:'import',cause:'import-qdte',occurredAt:new Date(f.clock()).toISOString()},new Date(f.clock()).toISOString());
  });
  f.later(60_000);await f.resync();
  // Robinhood reinvests the dividend: the fill carries the instrument id; the account now has 2.007417.
  f.later(1000);await fill(f,'drip-1',{quantity:'0.007417',price:'29.66',side:'buy',instrumentRef:'3f394e28-9cec-40b4-94c6-be2a7ea9be39',symbol:'QDTE',origin:'drip'});
  // Marked completed by the old code with nothing credited: the repair retries it.
  await f.db.query(`UPDATE account_executions SET attribution_state='completed',attributed_at=now() WHERE provider_ref='drip-1'`);
  f.setQdte('2.007417');f.later(1000);await f.resync();
  expect(await createAttributionSweep(f.database,f.core).run(f.account)).toMatchObject({completed:1,failed:0});
  expect((await f.db.query(`SELECT instrument_ref,quantity_delta::numeric(20,6)::text q FROM strategy_attribution_entries WHERE allocation_id=$1 AND entry_type='reinvestment'`,[f.qdteAllocation.allocationId])).rows).toEqual([{instrument_ref:'QDTE',q:'0.007417'}]);
  expect(await rekeyEquityClaims(f.database,f.clock)).toEqual({rekeyed:0,retried:0});
 }finally{await f.close();}
});
