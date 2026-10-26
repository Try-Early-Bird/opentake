import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import {append,unreleased,type EntryKind} from './ledger';

// One-time repairs for claims recorded before equities were keyed by ticker
// (see equityRef in evidence.ts). Strategy fills used to record Robinhood's
// instrument id while positions and imported claims use the ticker, so those
// claims never met the account. The ledger is append-only: each such entry is
// reversed and recorded again under its ticker, with the same amounts, cost
// and time. A reinvested dividend that was completed without crediting the
// strategy holding the ticker is attributed again. Both are idempotent and run
// before each attribution sweep; on a repaired ledger they find nothing.

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
interface Entry {
 id:string;allocation_id:string;transaction_id:string;entry_type:EntryKind;instrument_ref:string;symbol:string;
 quantity_delta:string;cash_delta:string;unit_cost:string|null;provider:string|null;execution_ref:string|null;
 source_kind:string;source_ref:string;occurred_at:Date|string;
}

export async function rekeyEquityClaims(database:Database,clock=()=>Date.now()):Promise<{rekeyed:number;retried:number}>{
 const now=new Date(clock()).toISOString();
 const entries=(await database.use(db=>db.query<Entry>(`SELECT e.id,e.allocation_id,e.transaction_id,e.entry_type,e.instrument_ref,e.symbol,e.quantity_delta::text,e.cash_delta::text,
  e.unit_cost::text,e.provider,e.execution_ref,e.source_kind,e.source_ref,e.occurred_at
  FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id
  WHERE e.asset_class='equity' AND e.symbol IS NOT NULL AND e.instrument_ref<>upper(e.symbol) AND e.entry_type<>'reversal'
   AND a.status IN ${unreleased} AND NOT EXISTS(SELECT 1 FROM strategy_attribution_entries r WHERE r.reversal_of=e.id)
  ORDER BY e.allocation_id,e.sequence`))).rows;
 let rekeyed=0;
 for(const e of entries){
  await database.use(db=>db.transaction(async(tx:Transaction)=>{
   const occurredAt=new Date(e.occurred_at).toISOString();
   const negate=(value:string)=>value.startsWith('-')?value.slice(1):value==='0'||/^0(\.0+)?$/.test(value)?value:`-${value}`;
   const common={allocationId:e.allocation_id,transactionId:e.transaction_id,symbol:e.symbol,occurredAt,
    ...(e.unit_cost===null?{}:{unitCost:e.unit_cost}),...(e.provider===null||e.execution_ref===null?{}:{provider:e.provider,executionRef:e.execution_ref})};
   await append(tx,{...common,entryType:'reversal',cause:`rekey:${e.id}`,instrumentRef:e.instrument_ref,quantityDelta:negate(e.quantity_delta),cashDelta:negate(e.cash_delta),
    sourceKind:'instrument_rekey',sourceRef:e.id,reversalOf:e.id,metadata:{reason:'claims are keyed by ticker',from:e.instrument_ref}},now);
   await append(tx,{...common,entryType:e.entry_type,cause:`rekey:${e.id}:ticker`,instrumentRef:e.symbol.toUpperCase(),quantityDelta:e.quantity_delta,cashDelta:e.cash_delta,
    sourceKind:e.source_kind,sourceRef:e.source_ref,metadata:{rekeyedFrom:e.id}},now);
  }));
  rekeyed+=1;
 }
 // A reinvestment completed without crediting the strategies that held its ticker then.
 const retried=await database.use(async db=>(await db.query(`UPDATE account_executions x SET attribution_state='pending',attributed_at=NULL
  WHERE x.attribution_state='completed' AND x.asset_class='equity' AND x.data->>'origin'='drip' AND x.data->>'side'='buy'
   AND NOT EXISTS(SELECT 1 FROM strategy_attribution_entries e WHERE e.account_id=x.account_id AND e.provider=x.provider AND e.execution_ref=x.provider_ref)
   AND EXISTS(SELECT 1 FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id
    WHERE e.account_id=x.account_id AND e.instrument_ref=upper(x.data->>'symbol') AND e.occurred_at<=x.occurred_at AND a.status IN ${unreleased}
    GROUP BY e.allocation_id HAVING sum(e.quantity_delta)>0)`)).affectedRows??0);
 return {rekeyed,retried};
}
