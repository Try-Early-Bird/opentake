import type {Transaction} from '@electric-sql/pglite';
import {riskEligibility} from '../trading/risk';
import {assertEligible} from '../trading/eligibility';
import {amount,format,type Candidate} from './order-planner';
/** Limits belong to an allocation and a native quote currency, never to the UI's selected account. */
export async function assertCoinbaseRisk(query:Pick<Transaction,'query'>,input:{allocationId:string;quote:string;orders:Candidate[];value?:string;reviewId?:string;now:number}){
 const policy=(await query.query<{risk_currency:string|null;max_daily_notional:string|null;max_loss:string|null}>('SELECT risk_currency,max_daily_notional::text,max_loss::text FROM coinbase_allocations WHERE id=$1',[input.allocationId])).rows[0];
 if(!policy)throw new Error('Allocation unavailable');
 if(policy.max_daily_notional===null&&policy.max_loss===null)return;
 if(policy.risk_currency!==input.quote)throw new Error('Allocation risk limits use another currency.');
 const start=new Date(input.now);start.setUTCHours(0,0,0,0); // Crypto risk day: UTC, independent of equity sessions.
 const placed=(await query.query<{total:string}>(`SELECT coalesce(sum((p.value->>'notional')::numeric),0)::text AS total
  FROM coinbase_allocation_orders o JOIN coinbase_order_reviews r ON r.allocation_id=o.allocation_id AND o.cause LIKE 'review:'||r.id::text||':%'
  CROSS JOIN LATERAL jsonb_array_elements(r.payload->'orders') p(value)
  LEFT JOIN coinbase_order_dispatches d ON d.order_id=o.id
  WHERE o.allocation_id=$1 AND ($2::uuid IS NULL OR r.id<>$2) AND r.payload->>'quote'=$3 AND p.value->>'product'=o.product
   AND ((d.state IN ('sending','unknown','accepted') AND d.started_at >= $4)
    OR (o.state='prepared' AND r.expires_at>$5))`,[input.allocationId,input.reviewId??null,input.quote,start.toISOString(),new Date(input.now).toISOString()])).rows[0].total;
 let capital:string|undefined;
 if(policy.max_loss!==null){
  const currencies=(await query.query<{asset:string;total:string}>("SELECT asset,sum(quantity)::text AS total FROM coinbase_allocation_entries WHERE allocation_id=$1 AND kind IN ('capital','release') GROUP BY asset",[input.allocationId])).rows;
  if(currencies.some(c=>c.asset!==input.quote&&!/^-?0(?:\.0+)?$/.test(c.total)))throw new Error('Loss limit requires capital evidence in the risk currency.');
  capital=currencies.find(c=>c.asset===input.quote)?.total??'0';
 }
 const result=riskEligibility({currency:input.quote,precision:36,maxDailyNotional:policy.max_daily_notional,placedToday:placed,planned:format(input.orders.reduce((sum,o)=>sum+amount(o.notional),0n)),maxLoss:policy.max_loss,capital,value:input.value});
 assertEligible(result,result.reasons.some(r=>r.code==='loss_limit_reached')?'Allocation loss limit reached.':'Allocation daily notional limit exceeded.');
}
