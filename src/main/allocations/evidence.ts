import type { Transaction } from '@electric-sql/pglite';
import type { NormalizedRobinhoodPosition, NormalizedRobinhoodPortfolio } from '../account-sync/snapshot-normalization';
import { deriveRobinhoodAttributionAmounts } from './attribution-math';
import { amount, format, unreleased } from './ledger';

export interface Fill {
 account_id:string;provider:string;provider_ref:string;order_ref:string;asset_class:'equity'|'option';
 attribution_state:'pending'|'deferred'|'completed';occurred_at:Date|string;
 data:{quantity:string;price:string;notionalAmount:string|null;feeAmount:string|null;side:string|null;
 instrumentRef:string;symbol:string|null;origin:string;orderCreatedAt:string|null};
}
/**
 * The key a Robinhood equity is claimed and measured by: its ticker. Robinhood's
 * positions carry only the symbol while its orders and fills carry an instrument
 * id, so claims, positions and fills meet on the uppercase ticker (as hosted keys
 * claims by symbol). Falls back to the stored ref when no symbol is known.
 */
export function equityRef(item:{symbol?:string|null;instrumentRef:string}):string{
 const symbol=item.symbol?.trim().toUpperCase();
 return symbol?symbol:item.instrumentRef;
}
export interface Observation<T> { id:string;observedAt:string;data:T }
export async function observation<T>(tx:Transaction,accountId:string,resource:'portfolio'|'equity_positions'|'crypto_positions',at?:string):Promise<Observation<T>|null> {
 const table=resource==='portfolio'?'portfolio_snapshots':'position_snapshots';
 const column=resource==='portfolio'?'portfolio_snapshot_id':'position_snapshot_id';
 return (await tx.query<Observation<T>>(`SELECT o.id,o.observed_at::text AS "observedAt",s.data FROM account_observations o
 JOIN ${table} s ON s.id=o.${column} AND s.account_id=o.account_id WHERE o.account_id=$1 AND o.resource=$2
 AND ($3::timestamptz IS NULL OR o.observed_at<=$3) ORDER BY o.observed_at DESC,o.id LIMIT 1`,[accountId,resource,at??null])).rows[0]??null;
}
export function fillAmounts(fill:Fill) {
 amount(fill.data.quantity);amount(fill.data.price);
 if(fill.data.notionalAmount!==null)amount(fill.data.notionalAmount);
 if(fill.data.feeAmount!==null)amount(fill.data.feeAmount);
 return deriveRobinhoodAttributionAmounts({...fill.data,assetClass:fill.asset_class});
}
export async function fillsSince(tx:Transaction,accountId:string,at:string,until?:string):Promise<Fill[]> {
 return (await tx.query<Fill>(`SELECT * FROM account_executions WHERE account_id=$1 AND occurred_at>$2
 AND ($3::timestamptz IS NULL OR occurred_at<=$3) ORDER BY occurred_at,provider_ref`,[accountId,at,until??null])).rows;
}
export async function claimed(tx:Transaction,accountId:string,instrumentRef:string|null) {
 return (await tx.query<{allocationId:string;quantity:string}>(`SELECT a.id AS "allocationId",
 coalesce(sum(CASE WHEN $2::text IS NULL THEN e.cash_delta ELSE e.quantity_delta END),0)::text AS quantity
 FROM strategy_allocations a LEFT JOIN strategy_attribution_entries e ON e.allocation_id=a.id
 AND ($2::text IS NULL OR e.instrument_ref=$2)
 WHERE a.account_id=$1 AND a.status IN ${unreleased} GROUP BY a.id ORDER BY a.id`,[accountId,instrumentRef])).rows;
}
export async function measuredCash(tx:Transaction,accountId:string,now:string,requireFresh=true) {
 const observed=await observation<NormalizedRobinhoodPortfolio>(tx,accountId,'portfolio',now);
 if(!observed||observed.data.currency!=='USD'||observed.data.cash===null)throw new Error('Complete USD cash observation required');
 if(requireFresh)await fresh(tx,accountId,'portfolio',observed.observedAt,now);
 let cash=amount(observed.data.cash);
 for(const fill of await fillsSince(tx,accountId,observed.observedAt,now)){
  const delta=fillAmounts(fill);if(!delta)throw new Error('Unmeasured account cash activity');
  // DRIP reinvestment spends the dividend itself, which never entered this cash observation.
  // Without a separate cash-dividend event, defer cash measurement across it.
  if(fill.data.origin==='drip')throw new Error('Fresh cash observation required after reinvestment');
  cash+=amount(delta.cashDelta)+amount(delta.feeCashDelta??'0');
 }
 return {cash,observationId:observed.id,observedAt:observed.observedAt};
}
export async function measuredShares(tx:Transaction,accountId:string,instrumentRef:string,now:string,requireFresh=true) {
 const observed=await observation<NormalizedRobinhoodPosition[]>(tx,accountId,'equity_positions',now);
 if(!observed)throw new Error('Complete equity observation required');
 if(requireFresh)await fresh(tx,accountId,'equity_positions',observed.observedAt,now);
 const positions=observed.data.filter(p=>p.instrumentRef===instrumentRef);
 if(positions.some(p=>p.currency!=='USD'||p.side==='short'))throw new Error('Unsupported account position');
 let quantity=positions.reduce((sum,p)=>sum+amount(p.quantity),0n);
 for(const fill of await fillsSince(tx,accountId,observed.observedAt,now)){
  if(fill.asset_class!=='equity'||equityRef(fill.data)!==instrumentRef)continue;
  const delta=fillAmounts(fill);if(!delta)throw new Error('Unknown account fill direction');quantity+=amount(delta.quantityDelta);
 }
 return {quantity,observationId:observed.id,observedAt:observed.observedAt,positions};
}
async function fresh(tx:Transaction,accountId:string,resource:string,observedAt:string,now:string) {
 if(Date.parse(now)-Date.parse(observedAt)>15*60_000)throw new Error('Fresh account observation required');
 const rows=(await tx.query<{resource:string;watermark:Date}>(`SELECT resource,watermark FROM account_sync_checkpoints
 WHERE account_id=$1 AND resource IN ($2,'equity_orders','option_orders') AND discovery_complete`,[accountId,resource])).rows;
 if(rows.length!==3||rows.some(row=>Date.parse(now)-new Date(row.watermark).getTime()>15*60_000))throw new Error('Complete account synchronization required');
}
export function proportion(total:bigint,claims:{allocationId:string;quantity:string}[]) {
 const positive=claims.filter(c=>amount(c.quantity)>0n);
 const sum=positive.reduce((value,c)=>value+amount(c.quantity),0n);
 if(total<0n||total>sum)throw new Error('Invalid shortfall assignment');
 if(sum===0n)return [];
 let remaining=total;
 return positive.map((c,index)=>{
  const units=index===positive.length-1?remaining:total*amount(c.quantity)/sum;remaining-=units;
  return {allocationId:c.allocationId,quantity:format(units)};
 });
}
