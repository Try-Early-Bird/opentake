import { setImmediate as yieldToHost } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import {orderEvidence} from './trading/activity';
import {observedOrderState} from '../shared/trading';
import type { DatabaseClient as PGlite } from './database-client';
import type {NotificationInput} from '../shared/notifications';
import {actionProgress,type ActionChild,type ActionOrder} from '../shared/action-notification';
import type {OrderActivity} from '../shared/order-activity';
import type {MixedWithdrawal} from '../shared/mixed-withdrawal';
/** Group only explicit transaction/review identities. Never group by symbol or time proximity. */
export async function syncActionNotifications(db:Pick<PGlite,'query'|'transaction'>,now:number,recovery=false){
 // Gather local evidence without holding the connection across the whole history.
 const tx=db;
  const since=new Date(now-30*86400000).toISOString();
  const children:ActionChild[]=[];
  const evidence=(await tx.query<{payload:OrderActivity}>(`SELECT DISTINCT ON (venue,account_id,order_id) payload FROM order_activity ORDER BY venue,account_id,order_id,sequence DESC`)).rows.map(r=>r.payload);
  const live=await orderEvidence(tx);
  const order=(id:string,symbol:string,side:string,state:string,amount:string|null,currency:string,venue:string,account:string):ActionOrder=>{
   const fresh=live.find(e=>e.orderId===id&&e.venue===venue);
   const e=fresh?{...fresh,execution:{state:observedOrderState(fresh.state,fresh.filledQuantity)}}:evidence.find(e=>e.orderId===id&&e.venue===venue);
   return {id,symbol:symbol.split('-')[0],side,state:e?.execution.state??(state==='closed'?'unknown':state),amount:e?(e.execution.state==='filled'||e.execution.state==='partially_filled'?e.filledNotional??null:e.notional??amount):amount,currency,venue,account};
  };
  const rh=(await tx.query<{id:string;strategyId:string;takeTitle:string;kind:string;at:Date;account:string;pending:string|null;outcome:string|null;closed:boolean;details:{preview?:{legs:{symbol:string;notional:string}[]}}}>(`SELECT t.id,a.strategy_id AS "strategyId",coalesce(v.metadata->>'title','Your Take') AS "takeTitle",t.kind,t.created_at AS at,coalesce(ac.nickname,ac.masked_number) AS account,t.pending_reason AS pending,t.outcome,t.details,(t.kind='detachment' OR (t.kind='exit' AND EXISTS(SELECT 1 FROM strategy_allocation_closures c WHERE c.allocation_id=a.id AND c.status IN ('sold','held') AND c.completed_at>=t.created_at))) AS closed
   FROM strategy_allocation_transactions t JOIN strategy_allocations a ON a.id=t.allocation_id JOIN linked_accounts ac ON ac.id=a.account_id JOIN strategy_versions v ON v.id=a.applied_version_id
   WHERE t.created_at>$1 AND (t.kind IN ('investment','contribution','redemption','exit','rebalance') OR (t.kind='detachment' AND t.idempotency_key LIKE 'release:close_hold:%' AND NOT EXISTS(SELECT 1 FROM strategy_allocation_transactions x WHERE x.allocation_id=t.allocation_id AND x.kind='exit')))`,[since])).rows;
  // Bound evidence prefetch; keep each notification group atomic and yield below.
  const activeRh=rh.filter(r=>r.outcome!=='superseded');
  for(let offset=0;offset<activeRh.length;offset+=10){
   const batch=activeRh.slice(offset,offset+10),ids=batch.map(r=>r.id);
   const batchLegs=(await tx.query<{transactionId:string;id:string;symbol:string;side:string;status:string;amount:string|null}>(`SELECT transaction_id AS "transactionId",coalesce(order_intent_id,id)::text AS id,symbol,side,status,coalesce(order_request->>'dollar_amount',order_request->>'notional') AS amount FROM strategy_executions WHERE transaction_id=ANY($1::uuid[]) ORDER BY transaction_id,created_at,id`,[ids])).rows;
   const batchReceipts=(await tx.query<{transactionId:string;id:string;type:string;amount:string}>(`SELECT transaction_id AS "transactionId",transaction_id::text||':'||entry_type AS id,entry_type AS type,abs(sum(cash_delta))::text AS amount FROM strategy_attribution_entries e WHERE transaction_id=ANY($1::uuid[]) AND entry_type IN ('capital_allocated','capital_released') AND NOT EXISTS(SELECT 1 FROM strategy_attribution_entries x WHERE x.reversal_of=e.id) GROUP BY transaction_id,entry_type`,[ids])).rows;
   for(const r of batch){
   const legs=batchLegs.filter(l=>l.transactionId===r.id);
   const receipts:{id:string;type:string;amount:string}[]=batchReceipts.filter(e=>e.transactionId===r.id);
   if(r.kind==='exit'){
    const closeReceipts=(await tx.query<{id:string;type:string;amount:string}>(`SELECT d.id::text||':capital_released' AS id,'capital_released' AS type,abs(e.cash_delta)::text AS amount FROM strategy_allocation_transactions original JOIN strategy_allocation_closures c ON c.allocation_id=original.allocation_id JOIN strategy_allocation_transactions d ON d.allocation_id=c.allocation_id AND d.kind='detachment' AND d.created_at=c.completed_at JOIN strategy_attribution_entries e ON e.transaction_id=d.id AND e.entry_type='capital_released' WHERE original.id=$1 AND c.completed_at>=original.created_at AND NOT EXISTS(SELECT 1 FROM strategy_allocation_transactions newer WHERE newer.allocation_id=original.allocation_id AND newer.kind='exit' AND newer.created_at>original.created_at)`,[r.id])).rows;
    receipts.push(...closeReceipts);
   }
   const selling=['redemption','exit','detachment'].includes(r.kind),released=r.closed||receipts.some(r=>r.type==='capital_released');
   const orders=legs.map(l=>order(l.id,l.symbol,l.side,l.status,l.amount,'USD','robinhood',r.account));
   if(!orders.length&&r.details?.preview?.legs)for(const [i,l] of r.details.preview.legs.entries())orders.push(order(`planned:${r.id}:${i}`,l.symbol,selling?'sell':'buy','waiting',l.notional,'USD','robinhood',r.account));
   children.push({id:`rh:${r.id}`,strategyId:r.strategyId,takeTitle:r.takeTitle,kind:r.kind==='contribution'?'deposit':r.kind==='redemption'?'withdrawal':['exit','detachment'].includes(r.kind)?'close':r.kind==='rebalance'?'rebalance':'investment',at:new Date(r.at).toISOString(),venue:'robinhood',account:r.account,orders,
    state:r.outcome==='cancelled'?'cancelled':r.outcome?'attention':selling?released?'completed':r.pending?'waiting':'pending':orders.length&&orders.every(o=>o.state==='filled')?'completed':r.pending?'waiting':'pending',
    message:r.pending==='lots_unsettled'?'Waiting for shares to settle':r.pending==='market_closed'?'Waiting for market open':r.pending?.replaceAll('_',' ')??(selling&&!released&&orders.every(o=>o.state==='filled')?'Waiting for cash release':null),returned:receipts.filter(r=>r.type==='capital_released').map(r=>({currency:'USD',amount:r.amount})),receiptIds:receipts.map(r=>r.id)});
  }
  }
  const cb=(await tx.query<{id:string;strategyId:string;takeTitle:string;at:Date;account:string;state:string;needsApproval:boolean;payload:{quote:string;rebalance?:unknown;withdrawal?:{close?:boolean};orders:{product:string;side:string;notional:string}[]}}>(`SELECT r.id,a.strategy_id AS "strategyId",coalesce(sv.metadata->>'title',r.payload->>'takeTitle','Your Take') AS "takeTitle",r.created_at AS at,coalesce(c.label,ac.nickname,ac.masked_number) AS account,r.state,r.payload,
    (coalesce((SELECT confirm_trades FROM trading_preferences WHERE owner_id=sv.owner_id),false) OR EXISTS(SELECT 1 FROM strategy_rule_action_requests q LEFT JOIN strategy_rule_trades j ON j.request_id=q.id WHERE q.id=CASE WHEN r.payload->'rebalance'->>'ruleRequestId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN (r.payload->'rebalance'->>'ruleRequestId')::uuid END AND (q.evidence->'rule'->'policy'->>'approval'='ask' OR j.approval_pending))) AS "needsApproval"
    FROM coinbase_order_reviews r JOIN strategy_versions sv ON sv.id=r.version_id JOIN coinbase_allocations a ON a.id=r.allocation_id JOIN linked_accounts ac ON ac.id=r.account_id LEFT JOIN coinbase_connection_details c ON c.connection_id=ac.connection_id WHERE r.created_at>$1 AND r.state IN ('confirmed','settled','cancelled')`,[since])).rows;
  for(const r of cb){
   const legs=(await tx.query<{id:string;cause:string;state:string}>("SELECT id,cause,state FROM coinbase_allocation_orders WHERE cause LIKE $1",[`review:${r.id}:%`])).rows;
   const receipts=(await tx.query<{id:string;currency:string;amount:string}>(`SELECT e.id::text,e.asset AS currency,abs(e.quantity)::text AS amount FROM coinbase_allocation_entries e WHERE e.asset IN ('USD','USDC') AND (e.cause=$1 OR e.cause IN (SELECT 'capital:member:'||capital_review_id::text FROM coinbase_investments WHERE order_review_id=$2))`,[`withdrawal-return:${r.id}`,r.id])).rows;
   const orders=r.payload.orders.map((o,i)=>{const l=legs.find(l=>l.cause===`review:${r.id}:${i}`);return order(l?.id??`planned:${r.id}:${i}`,o.product,o.side,l?.state==='prepared'?'reserved':l?.state??'pending',o.notional,r.payload.quote,'coinbase',r.account);});
   const approval=r.state==='confirmed'&&r.needsApproval&&orders.length>0&&orders.every(o=>['reserved','reviewed'].includes(o.state));
   const selling=!!r.payload.withdrawal;
   children.push({id:`cb:${r.id}`,strategyId:r.strategyId,takeTitle:r.takeTitle,kind:r.payload.rebalance?'rebalance':r.payload.withdrawal?.close?'close':selling?'withdrawal':'deposit',at:new Date(r.at).toISOString(),venue:'coinbase',account:r.account,orders,
    state:approval?'awaiting_confirmation':r.state==='cancelled'?'cancelled':r.state==='settled'&&(!selling||receipts.length>0)?'completed':'pending',message:selling&&r.state==='settled'&&!receipts.length?'Waiting for cash release':null,returned:selling?receipts.map(({currency,amount})=>({currency,amount})):[],receiptIds:receipts.map(r=>r.id)});
  }
  const groups=new Map<string,ActionChild[]>(),claimed=new Set<string>();
  const mixed=(await tx.query<{id:string;take_id:string;state:string;created_at:Date}>('SELECT * FROM mixed_take_executions WHERE created_at>$1',[since])).rows;
  for(const m of mixed){
   const refs=(await tx.query<{cb:string|null;rh:string|null}>(`SELECT i.order_review_id::text AS cb,t.id::text AS rh FROM mixed_take_execution_legs l LEFT JOIN coinbase_investments i ON i.id=l.operation_id AND l.venue='coinbase' LEFT JOIN strategy_allocation_transactions t ON t.details->>'mixedOperationId'=l.operation_id::text AND l.venue='robinhood' WHERE l.execution_id=$1`,[m.id])).rows;
   const members=children.filter(c=>refs.some(r=>c.id===`cb:${r.cb}`||c.id===`rh:${r.rh}`));
   if(members.length){if(members.length<2&&members[0].state==='completed')members[0]={...members[0],state:'pending',message:'Waiting for the other account'};for(const c of members)claimed.add(c.id);groups.set(`mixed:${m.id}`,members);}
  }
  const withdrawals=(await tx.query<{payload:MixedWithdrawal}>("SELECT payload FROM mixed_take_withdrawals WHERE created_at>$1 AND state IN ('running','attention','completed')",[since])).rows;
  for(const {payload:m} of withdrawals){
   const members:ActionChild[]=[];
   for(const l of m.legs){
    const t=l.venue==='robinhood'?(await tx.query<{id:string}>("SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND idempotency_key=$2",[l.reference,`${m.kind==='close'?'close':'redeem'}:${l.operationId}`])).rows[0]:null;
    const child=children.find(c=>c.id===(l.venue==='coinbase'?`cb:${l.reference}`:`rh:${t?.id}`));
    if(child){members.push(child);claimed.add(child.id);}
   }
   if(members.length){if(members.length<m.legs.length)members[0]={...members[0],state:m.state==='attention'?'attention':'pending',message:'Waiting for the other account'};groups.set(`withdrawal:${m.id}`,members);}
  }
  const rebalances=(await tx.query<{id:string;state:string;reviews:string[]}>(`SELECT b.id,b.state,array_agg(r.id::text) AS reviews FROM coinbase_rebalance_runs b JOIN coinbase_order_reviews r ON r.allocation_id=b.allocation_id AND r.payload->'rebalance'->>'scheduledOn'=b.scheduled_on::text AND coalesce(r.payload->'rebalance'->>'trigger','schedule')=b.trigger WHERE b.created_at>$1 GROUP BY b.id,b.state`,[since])).rows;
  for(const b of rebalances){const members=children.filter(c=>b.reviews.some(r=>c.id===`cb:${r}`)&&!claimed.has(c.id));if(members.length){for(const c of members)claimed.add(c.id);if(b.state!=='completed')members[members.length-1]={...members.at(-1)!,state:b.state==='attention'?'attention':'pending',message:'Rebalance in progress'};groups.set(`rebalance:${b.id}`,members);}}
  for(const c of children)if(!claimed.has(c.id))groups.set(c.id,[c]);
  for(const [id,members] of [...groups].sort((a,b)=>a[1].map(c=>c.at).sort()[0].localeCompare(b[1].map(c=>c.at).sort()[0]))){
   await db.transaction(async tx=>{
   const progress=actionProgress(id,members),at=members.map(c=>c.at).sort()[0];
   const previous=(await tx.query<{payload:NotificationInput}>("SELECT payload FROM notifications WHERE payload->>'kind'='action_update' AND payload->'source'->>'id'=$1",[id])).rows[0]?.payload;
   progress.updatedAt=previous?.action&&previous.action.state!==progress.state&&['completed','attention'].includes(progress.state)?new Date(now).toISOString():previous?.action?.updatedAt??at;
   const requiresAction=progress.state==='attention'||progress.accounts.some(account=>account.state==='awaiting_confirmation');
   const payload:NotificationInput={kind:'action_update',context:{strategyId:members[0].strategyId},source:{type:'action',id},eventKey:'action',tier:requiresAction?'act_now':'know_today',requiresAction,occurredAt:at,title:progress.title,body:progress.takeTitle.slice(0,240),action:progress};
   const serialized=JSON.stringify(payload);
   // Compare JSON values, ignoring object key order and omitted undefined fields.
   // Pruning below must still run: duplicate cards can arrive after this action.
   if(!isDeepStrictEqual(previous,JSON.parse(serialized))){
   await tx.query('SELECT record_local_notification($1::jsonb,$2)',[serialized,recovery||Date.parse(at)<now-60000]);
   await tx.query("UPDATE notifications SET sequence=DEFAULT WHERE payload->>'kind'='action_update' AND payload->'source'->>'id'=$1 AND NOT pruned AND payload->'action'->>'state' IS DISTINCT FROM $2 AND $2 IN ('completed','attention')",[id,progress.state]);
   await tx.query(`UPDATE notifications SET payload=$2,seen=CASE WHEN payload->'action'->>'state' IS DISTINCT FROM $3 AND $3 IN ('completed','attention') THEN false ELSE seen END,delivery=CASE WHEN NOT $4 AND payload->'action'->>'state' IS DISTINCT FROM $3 AND $3 IN ('completed','attention') THEN 'pending' ELSE delivery END WHERE payload->>'kind'='action_update' AND payload->'source'->>'id'=$1 AND NOT pruned AND payload IS DISTINCT FROM $2::jsonb`,[id,serialized,progress.state,recovery]);
   }
   const orderIds=members.flatMap(c=>c.orders.map(o=>o.id)),receipts=members.flatMap(c=>c.receiptIds);
   await tx.query(`UPDATE notifications SET pruned=true,delivery='suppressed' WHERE NOT pruned AND ((payload->>'kind'='order_update' AND payload->'order'->>'orderId'=ANY($1::text[])) OR (payload->>'kind'='capital_update' AND payload->'source'->>'id'=ANY($2::text[])))`,[orderIds,receipts]);
   // The persisted order card owns this review's bell entry, including its outcome.
   // Suppress the generic rule notice only after the detailed card exists.
   const reviews=members.filter(c=>c.id.startsWith('cb:')).map(c=>c.id.slice(3));
   await tx.query(`UPDATE notifications SET pruned=true,delivery='suppressed'
    WHERE NOT pruned AND payload->'source'->>'type'='trading_queue' AND payload->>'eventKey'='rule-rebalance'
    AND payload->'source'->>'id' IN (SELECT payload->'rebalance'->>'ruleRequestId' FROM coinbase_order_reviews WHERE id=ANY($1::uuid[]))`,[reviews]);
   // Quote renewal is the same approval, not another cancelled/active action pair.
   await tx.query(`UPDATE notifications n SET pruned=true,delivery='suppressed' FROM coinbase_order_reviews old,coinbase_order_reviews latest
    WHERE n.payload->>'kind'='action_update' AND n.payload->'source'->>'id'='cb:'||old.id::text
    AND latest.id=ANY($1::uuid[]) AND old.id<>latest.id
    AND old.payload->'rebalance'->>'ruleRequestId'=latest.payload->'rebalance'->>'ruleRequestId'
    AND coalesce(old.payload->'rebalance'->>'phase','initial')=coalesce(latest.payload->'rebalance'->>'phase','initial')
    AND coalesce((old.payload->'rebalance'->>'quoteRevision')::int,0)<coalesce((latest.payload->'rebalance'->>'quoteRevision')::int,0)`,[reviews]);
   const transactions=members.filter(c=>c.id.startsWith('rh:')).map(c=>c.id.slice(3));
   await tx.query("UPDATE notifications SET pruned=true,delivery='suppressed' WHERE NOT pruned AND payload->>'kind'='trading_waiting' AND split_part(payload->'source'->>'id',':',4)=ANY($1::text[])",[transactions]);
   // A mixed parent replaces child action cards, including cards seen before the other venue started.
   if(id.startsWith('mixed:')||id.startsWith('withdrawal:')||id.startsWith('rebalance:'))await tx.query("UPDATE notifications SET pruned=true,delivery='suppressed' WHERE NOT pruned AND payload->>'kind'='action_update' AND payload->'source'->>'id'=ANY($1::text[])",[members.map(c=>c.id)]);
   });
   await yieldToHost();
  }
}
