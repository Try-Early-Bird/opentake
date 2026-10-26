import type {DatabaseClient} from '../database-client';
import {marketKey,type MarketHit} from '../../shared/search';
import type {StrategyInstrument} from '../../shared/strategies';
import {amount} from '../allocations/ledger';
export type TrackingReason='holding'|'take_target'|'draft_target'|'take_ownership'|'open_order';
export interface TrackedAsset {
 key:string;identity:MarketHit['identity'];symbol:string;
 reasons:TrackingReason[];accountIds:string[];strategyIds:string[];
 observedAt:string|null;priceObservedAt:string|null;
}
type Query=Pick<DatabaseClient,'query'>;
/** Derived from durable source records on each read. No network calls and no
 * independent holdings copy to become stale. Currently supplies Robinhood
 * consumers; other venue adapters can feed the same identity/reason boundary. */
export async function trackedRobinhoodAssets(db:Query,accountId?:string):Promise<TrackedAsset[]> {
 const found=new Map<string,TrackedAsset>();
 const add=(identity:MarketHit['identity'],symbol:string,reason:TrackingReason,account?:string,strategy?:string,observed?:unknown,priceObserved?:unknown)=>{
  const key=marketKey({identity}),row=found.get(key)??{key,identity,symbol,reasons:[],accountIds:[],strategyIds:[],observedAt:null,priceObservedAt:null};
  if(!row.reasons.includes(reason))row.reasons.push(reason);
  if(account&&!row.accountIds.includes(account))row.accountIds.push(account);
  if(strategy&&!row.strategyIds.includes(strategy))row.strategyIds.push(strategy);
  const stamp=(value:unknown)=>{const time=value instanceof Date?value.getTime():typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(time)?new Date(time).toISOString():null;};
  for(const [field,value] of [['observedAt',observed],['priceObservedAt',priceObserved]] as const){const date=stamp(value);if(date&&(!row[field]||date>row[field]!))row[field]=date;}
  found.set(key,row);
 };
 const equity=(symbol:string)=>({venue:'robinhood',instance:'production',kind:'equity',reference:symbol.toUpperCase()});
 const fromRef=(ref:string,symbol:string):MarketHit['identity']=>{
  if(ref.startsWith('[')){
   const value:unknown=JSON.parse(ref);
   if(!Array.isArray(value)||value.length!==6||value[0]!=='robinhood'||value[1]!=='production'||value[3]!=='crypto'||typeof value[2]!=='string')throw Error('Invalid tracked crypto identity');
   return {venue:value[0],instance:value[1],reference:value[2],kind:value[3]};
  }
  return equity(symbol);
 };
 const positions=(await db.query<{account_id:string;observed_at:Date;data:any[];resource:string}>(`SELECT DISTINCT ON(o.account_id,o.resource) o.account_id,o.observed_at,s.data,o.resource
  FROM account_observations o JOIN position_snapshots s ON s.id=o.position_snapshot_id JOIN linked_accounts a ON a.id=o.account_id
  JOIN platform_connections c ON c.id=a.connection_id
  WHERE c.venue='robinhood' AND a.available AND a.selected AND ($1::uuid IS NULL OR a.id=$1)
   AND o.resource IN ('equity_positions','crypto_positions') ORDER BY o.account_id,o.resource,o.observed_at DESC,o.id DESC`,[accountId??null])).rows;
 for(const snapshot of positions)for(const p of snapshot.data){
  if(!p.symbol||amount(p.quantity)===0n)continue;
  const identity=snapshot.resource==='crypto_positions'?fromRef(p.instrumentRef,p.symbol):equity(p.symbol);
  if(snapshot.resource==='crypto_positions'&&identity.kind!=='crypto')throw Error('Missing tracked crypto identity');
  add(identity,p.symbol,'holding',snapshot.account_id,undefined,snapshot.observed_at,p.priceObservedAt);
 }
 const targets=(await db.query<{strategy_id:string;account_id:string|null;reason:TrackingReason;instrument:StrategyInstrument}>(`
  SELECT s.id AS strategy_id,NULL::uuid AS account_id,'take_target' AS reason,w->'instrument' AS instrument
   FROM strategies s JOIN strategy_versions v ON v.id=s.current_version_id,jsonb_array_elements(v.spec->'target'->'weights') w WHERE s.archived_at IS NULL
  UNION ALL SELECT s.id,NULL::uuid,'draft_target',w->'instrument'
   FROM strategies s JOIN strategy_proposals p ON p.id=s.draft_revision_id,jsonb_array_elements(p.payload->'spec'->'target'->'weights') w WHERE s.archived_at IS NULL
  UNION ALL SELECT a.strategy_id,a.account_id,'take_target',w->'instrument'
   FROM strategy_allocations a JOIN linked_accounts l ON l.id=a.account_id JOIN strategy_versions v ON v.id IN (a.applied_version_id,a.accepted_version_id),jsonb_array_elements(v.spec->'target'->'weights') w
   WHERE a.status IN ('active','paused','diverged') AND l.selected AND l.available AND ($1::uuid IS NULL OR a.account_id=$1)`,[accountId??null])).rows;
 for(const t of targets){const i=t.instrument;if(i.venue!=='robinhood')continue;
  if(i.market&&(i.market.venue!=='robinhood'||i.market.instance!=='production'||i.market.kind!=='crypto'))continue;
  add(i.market?{venue:i.market.venue,instance:i.market.instance,kind:i.market.kind,reference:i.market.reference}:equity(i.symbol),i.symbol,t.reason,t.account_id??undefined,t.strategy_id);
 }
 const owned=(await db.query<{account_id:string;strategy_id:string;instrument_ref:string;symbol:string;quantity:string}>(`SELECT a.account_id,a.strategy_id,e.instrument_ref,max(e.symbol) AS symbol,sum(e.quantity_delta)::text AS quantity
  FROM strategy_attribution_entries e JOIN strategy_allocations a ON a.id=e.allocation_id JOIN linked_accounts l ON l.id=a.account_id
  WHERE a.status IN ('active','paused','diverged') AND l.selected AND l.available AND e.instrument_ref IS NOT NULL AND e.symbol IS NOT NULL
   AND ($1::uuid IS NULL OR a.account_id=$1) GROUP BY a.account_id,a.strategy_id,e.instrument_ref HAVING sum(e.quantity_delta)<>0`,[accountId??null])).rows;
 for(const p of owned)add(fromRef(p.instrument_ref,p.symbol),p.symbol,'take_ownership',p.account_id,p.strategy_id);
 const intents=(await db.query<{account_id:string;strategy_id:string|null;asset_class:string;order_request:any;review_result:any}>(`SELECT i.account_id,a.strategy_id,i.asset_class,i.order_request,i.review_result
  FROM order_intents i JOIN linked_accounts l ON l.id=i.account_id LEFT JOIN strategy_allocations a ON a.id=i.allocation_id
  LEFT JOIN order_fill_checkpoints f ON f.intent_id=i.id
  WHERE l.selected AND l.available AND ($1::uuid IS NULL OR i.account_id=$1) AND i.asset_class IN ('equity','crypto')
   AND (i.status IN ('placing','placement_unknown','approval_pending') OR (i.status='placed' AND CASE WHEN i.asset_class='crypto'
    THEN NOT coalesce((f.snapshot->>'terminal')::boolean,false)
    ELSE NOT EXISTS(SELECT 1 FROM account_orders o WHERE o.account_id=i.account_id AND o.provider='robinhood' AND o.provider_ref=i.provider_order_ref AND o.terminal) END))`,[accountId??null])).rows;
 for(const i of intents){
  if(i.asset_class==='crypto'){
   const ref=i.order_request.currency_pair_id,symbol=i.review_result?.symbol;
   if(typeof ref!=='string'||typeof symbol!=='string')throw Error('Missing tracked order identity');
   add({venue:'robinhood',instance:'production',kind:'crypto',reference:ref},symbol,'open_order',i.account_id,i.strategy_id??undefined);
  }else if(typeof i.order_request.symbol==='string')add(equity(i.order_request.symbol),i.order_request.symbol,'open_order',i.account_id,i.strategy_id??undefined);
 }
 const orders=(await db.query<{account_id:string;asset_class:string;data:{symbol?:string;instrumentRef?:string}}>(`SELECT o.account_id,o.asset_class,o.data FROM account_orders o JOIN linked_accounts l ON l.id=o.account_id
  WHERE o.provider='robinhood' AND o.asset_class IN ('equity','crypto') AND NOT o.terminal AND l.selected AND l.available AND ($1::uuid IS NULL OR o.account_id=$1)`,[accountId??null])).rows;
 for(const o of orders)if(o.data.symbol){
  const identity=o.asset_class==='crypto'?fromRef(o.data.instrumentRef??'',o.data.symbol):equity(o.data.symbol);
  if(o.asset_class==='crypto'&&identity.kind!=='crypto')throw Error('Missing tracked crypto order identity');
  add(identity,o.data.symbol,'open_order',o.account_id);
 }
 return [...found.values()].map(row=>({...row,reasons:row.reasons.sort(),accountIds:row.accountIds.sort(),strategyIds:row.strategyIds.sort()})).sort((a,b)=>a.key.localeCompare(b.key));
}
