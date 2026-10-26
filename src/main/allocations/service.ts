import {personalCashHeld,unsettledTakeCash} from '../orders/cash-holds';
import {executionBasket} from '../mixed-execution/basket';
import { assertBasketExecution, type BasketSpec } from '../../shared/strategies';
import type { Transaction } from '@electric-sql/pglite';
import type { createDatabaseLifecycle } from '../database';
import type { NormalizedRobinhoodPosition } from '../account-sync/snapshot-normalization';
import { allocation, amount, append, format, holdings, instruction, positive, unreleased } from './ledger';
import { claimed, equityRef, fillAmounts, fillsSince, measuredCash, measuredShares, observation, type Fill } from './evidence';
import { splitReinvestedShares } from './attribution-math';
import { closeCase, keepReduced, openCase, reconcile, refreshStatuses, type LotObservation } from './reconciliation';
import { deriveAllocationPnl } from './allocation-pnl';
import { deriveAllocationValuation } from './allocation-valuation';
import { matchFillToLot, selectLotsForSale, selectLotsWithFallback, type RobinhoodTaxLot } from './tax-lots';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
export interface CapitalRequest {allocationId:string;accountId:string;strategyId:string;versionId:string;amount:string;cause:string}
export interface FillContext {
 // The caller must supply this from its durable intent -> execution -> instruction
 // join, never from model/renderer input. This core has no IPC or MCP write surface.
 instruction?:{allocationId:string;transactionId:string;accountId:string;provider:string;orderRef:string};
 // A verified entitlement observation, not current holdings or guessed claims.
 entitlement?:{at:string;observationId:string};
 // Opentake placed this order for the member themselves (Settings > Trading): an
 // agentic order with a known cause, attributed like one they placed in Robinhood.
 memberDirected?:true;
}
export function createAllocationCore(database:Database,clock=()=>Date.now()) {
 const time=()=>new Date(clock()).toISOString();
 const atomic=<T>(work:(tx:Transaction,now:string)=>Promise<T>)=>database.use(db=>db.transaction(tx=>work(tx,time())));
 async function validateLotEvidence(tx:Transaction,input:{accountId:string;provider:string;observedAt:string;complete:true;lots:RobinhoodTaxLot[]},now:string){
  if(!input.complete||!Number.isFinite(Date.parse(input.observedAt))||Date.parse(input.observedAt)>Date.parse(now)||Date.parse(now)-Date.parse(input.observedAt)>60_000)throw new Error('Fresh complete lot evidence required');
  if(!(await tx.query(`SELECT 1 FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id WHERE a.id=$1 AND c.venue=$2`,[input.accountId,input.provider])).rows.length)throw new Error('Lot evidence provider does not match account');
  const ids=new Set<string>();for(const lot of input.lots){
   if(ids.has(lot.openLotId)||!lot.openLotId||amount(lot.quantity)<0n)throw new Error('Invalid lot evidence');ids.add(lot.openLotId);
   if(lot.unitCost!==null&&amount(lot.unitCost)<0n)throw new Error('Invalid lot cost');
  }
 }
 async function availableCash(tx:Transaction,accountId:string,now:string) {
  const measured=await measuredCash(tx,accountId,now);
  const claims=await claimed(tx,accountId,null);
  if(claims.some(c=>amount(c.quantity)<0n))throw new Error('Resolve negative allocation cash');
  const reserved=claims.reduce((sum,c)=>sum+amount(c.quantity),0n);
  return {...measured,available:measured.cash-reserved-await personalCashHeld(tx,accountId)-await unsettledTakeCash(tx,accountId)};
 }
 async function eligible(tx:Transaction,input:CapitalRequest) {
  const row=(await tx.query<{id:string;spec:BasketSpec}>(`SELECT a.id,v.spec FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
   JOIN strategies s ON s.owner_id=c.owner_id JOIN strategy_versions v ON v.strategy_id=s.id
   WHERE a.id=$1 AND s.id=$2 AND v.id=$3 AND s.status='committed' AND s.archived_at IS NULL
   AND a.available AND a.selected AND a.agentic_allowed AND c.venue='robinhood' AND c.status='connected'`,[input.accountId,input.strategyId,input.versionId])).rows[0];
  if(!row)throw new Error('Eligible account and committed basket version required');
  assertBasketExecution(await executionBasket(tx,row.spec,{strategyId:input.strategyId,versionId:input.versionId,accountId:input.accountId},'robinhood'));
 }
 async function capital(tx:Transaction,input:CapitalRequest,kind:'investment'|'contribution',now:string) {
  const requested=positive(input.amount);await eligible(tx,input);
  const existing=(await tx.query<{id:string;account_id:string;strategy_id:string;applied_version_id:string}>(`SELECT * FROM strategy_allocations WHERE id=$1`,[input.allocationId])).rows[0];
  if(existing&&(existing.account_id!==input.accountId||existing.strategy_id!==input.strategyId||existing.applied_version_id!==input.versionId))throw new Error('Allocation identity mismatch');
  const old=(await tx.query<{id:string}>(`SELECT id FROM strategy_allocation_transactions WHERE allocation_id=$1 AND idempotency_key=$2`,[input.allocationId,input.cause])).rows[0];
  const request={allocationId:input.allocationId,kind,cause:input.cause,requestedAmount:format(requested),pendingReason:'execution_not_integrated'};
  if(old)return {allocationId:input.allocationId,transactionId:await instruction(tx,request,now)};
  if(kind==='investment'&&existing)throw new Error('Allocation already exists');
  if(kind==='contribution'){
   const a=await allocation(tx,input.allocationId);
   if(a.status!=='active'||a.restore_required)throw new Error('Allocation cannot accept capital');
  }
  const available=await availableCash(tx,input.accountId,now);
  if(requested>available.available)throw new Error('Insufficient unclaimed account cash');
  if(!existing)await tx.query(`INSERT INTO strategy_allocations(id,account_id,strategy_id,applied_version_id,currency,status,created_at,updated_at)
   VALUES($1,$2,$3,$4,'USD','active',$5,$5)`,[input.allocationId,input.accountId,input.strategyId,input.versionId,now]);
  const transactionId=await instruction(tx,request,now);
  await append(tx,{allocationId:input.allocationId,transactionId,entryType:'capital_allocated',cashDelta:format(requested),cause:`capital:${input.cause}`,sourceKind:'member_instruction',sourceRef:transactionId,occurredAt:now},now);
  await tx.query(`INSERT INTO strategy_evidence_pins(allocation_id,observation_id,reason) VALUES($1,$2,'capital') ON CONFLICT DO NOTHING`,[input.allocationId,available.observationId]);
  return {allocationId:input.allocationId,transactionId};
 }
 async function noOpenOrders(tx:Transaction,accountId:string,allocationId?:string) {
  // Conservative: even an unrelated open account order blocks.
  if((await tx.query(`SELECT 1 FROM account_orders WHERE account_id=$1 AND NOT terminal LIMIT 1`,[accountId])).rows.length)throw new Error('Wait for open account orders to settle');
  if((await tx.query(`SELECT 1 FROM account_executions WHERE account_id=$1 AND attribution_state<>'completed' LIMIT 1`,[accountId])).rows.length)throw new Error('Wait for fill attribution to complete');
  // An order Opentake may have sent is in flight until it resolves. A placement
  // that is mid-send or of unknown outcome may yet spend or raise cash on this account,
  // and the allocation's own planned legs (queued, sent or unresolved) still need its claims.
  if((await tx.query(`SELECT 1 FROM order_intents WHERE account_id=$1 AND status IN ('placing','placement_unknown','approval_pending') LIMIT 1`,[accountId])).rows.length)throw new Error('Wait for an order with an unknown outcome to be matched');
  if((await tx.query(`SELECT 1 FROM order_cash_holds h JOIN order_intents i ON i.id=h.intent_id WHERE i.account_id=$1 AND h.state='held' LIMIT 1`,[accountId])).rows.length)throw new Error('Wait for reserved orders to reconcile');
  if(allocationId!==undefined&&(await tx.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1
   AND status IN ('queued','reviewed','submitting','submitted','placement_unknown','partially_filled','reconciliation_required') LIMIT 1`,[allocationId])).rows.length)throw new Error('Wait for this take\'s orders to finish');
 }
 return {
  preview(input:CapitalRequest){return atomic(async(tx,now)=>{
   const requested=positive(input.amount);await eligible(tx,input);const m=await availableCash(tx,input.accountId,now);
   return {availableCash:format(m.available),requestedAmount:format(requested),canFund:requested<=m.available,hypothetical:{cash:format(requested),positions:[]}};
  });},
  invest:(input:CapitalRequest)=>atomic((tx,now)=>capital(tx,input,'investment',now)),
  addCapital:(input:CapitalRequest)=>atomic((tx,now)=>capital(tx,input,'contribution',now)),
  releaseCash(input:{allocationId:string;amount:string;cause:string}){return atomic(async(tx,now)=>{
   const requested=positive(input.amount);const a=await allocation(tx,input.allocationId);
   const transactionId=await instruction(tx,{allocationId:a.id,kind:'cash_release',cause:input.cause,requestedAmount:format(requested)},now);
   const old=(await tx.query(`SELECT 1 FROM strategy_attribution_entries WHERE allocation_id=$1 AND idempotency_key=$2`,[a.id,`release:${input.cause}`])).rows[0];if(old)return;
   await noOpenOrders(tx,a.account_id,a.id);
   if(a.restore_required||a.status==='diverged')throw new Error('Resolve account evidence before releasing cash');
   if(amount((await holdings(tx,a.id)).cash)<requested)throw new Error('Insufficient allocation cash');
   await append(tx,{allocationId:a.id,transactionId,entryType:'capital_released',cashDelta:format(-requested),cause:`release:${input.cause}`,sourceKind:'member_instruction',sourceRef:transactionId,occurredAt:now},now);
  });},
  attribute(input:{accountId:string;provider:string;executionRef:string},context:FillContext={}){return atomic(async(tx,now)=>{
   const fill=(await tx.query<Fill>(`SELECT * FROM account_executions WHERE account_id=$1 AND provider=$2 AND provider_ref=$3`,[input.accountId,input.provider,input.executionRef])).rows[0];
   if(!fill)throw new Error('Fill evidence not found');if(fill.attribution_state==='completed')return 'completed' as const;
   if(fill.provider==='coinbase')throw new Error('Coinbase allocation attribution is not enabled');
   const at=new Date(fill.occurred_at).toISOString();
   const ref=`fill:${fill.provider}:${fill.provider_ref}`;const scope=ref;
   // Claims and positions are keyed by ticker; a fill carries Robinhood's instrument id (see equityRef).
   const instrumentRef=equityRef(fill.data);
   const affected=await claimed(tx,fill.account_id,instrumentRef);
   async function defer(reason:string){
    await openCase(tx,{accountId:fill.account_id,scope,cause:reason,instrumentRef,impacts:affected,evidence:{provider:fill.provider,executionRef:fill.provider_ref}},now);
    await tx.query(`UPDATE account_executions SET attribution_state='deferred',attributed_at=NULL WHERE account_id=$1 AND provider=$2 AND provider_ref=$3`,[fill.account_id,fill.provider,fill.provider_ref]);return 'deferred' as const;
   }
   const delta=fillAmounts(fill);
   const existed=(await tx.query(`SELECT 1 FROM strategy_allocations WHERE account_id=$1 AND created_at<=$2 LIMIT 1`,[fill.account_id,at])).rows.length>0;
   if(!existed&&!context.instruction){
    // History predating every local allocation has no local claim to change,
    // including orders placed by a different app. Record that explicit decision.
   }else if(fill.asset_class==='option'){
    if(context.instruction)throw new Error('Options attribution is not supported');
   }else if(!delta)return defer('incomplete_fill');
   else if(context.instruction){
    const link=context.instruction;const a=await allocation(tx,link.allocationId);
    if(link.accountId!==fill.account_id||a.account_id!==fill.account_id||link.provider!==fill.provider||link.orderRef!==fill.order_ref)throw new Error('Causal link crosses account or order');
    if(fill.data.origin!=='agentic')throw new Error('Take fill requires an agentic provider order');
    const cause=(await tx.query(`SELECT 1 FROM strategy_allocation_transactions WHERE id=$1 AND allocation_id=$2 AND created_at<=$3`,[link.transactionId,a.id,at])).rows[0];
    if(!cause)throw new Error('Instruction must precede its fill');
    if(a.status==='detached'||a.status==='closed')return defer('fill_after_release');
    // Composite foreign keys also ensure the instruction belongs to this allocation.
    await append(tx,{allocationId:a.id,transactionId:link.transactionId,entryType:'fill',instrumentRef,symbol:fill.data.symbol,
     quantityDelta:delta.quantityDelta,cashDelta:delta.cashDelta,unitCost:fill.data.price,provider:fill.provider,executionRef:fill.provider_ref,
     cause:ref,sourceKind:'provider_execution',sourceRef:fill.provider_ref,occurredAt:at},now);
    if(delta.feeCashDelta!==null)await append(tx,{allocationId:a.id,transactionId:link.transactionId,entryType:'fee',cashDelta:delta.feeCashDelta,
     provider:fill.provider,executionRef:fill.provider_ref,cause:`${ref}:fee`,sourceKind:'provider_execution',sourceRef:fill.provider_ref,occurredAt:at},now);
    const held=await holdings(tx,a.id);
    if(amount(held.cash)<-5n*10n**16n||held.positions.some(p=>amount(p.quantity)<0n))await openCase(tx,{accountId:a.account_id,scope:`ledger:${a.id}`,cause:'negative_subledger_balance',impacts:[{allocationId:a.id,quantity:'0'}],evidence:{executionRef:fill.provider_ref}},now);
   }else if(fill.data.origin==='drip'&&fill.data.side==='buy'){
    const entitlement=context.entitlement;
    if(!entitlement||!Number.isFinite(Date.parse(entitlement.at))||Date.parse(entitlement.at)>Date.parse(at))return defer('missing_entitlement_evidence');
    const evidence=await observation<NormalizedRobinhoodPosition[]>(tx,fill.account_id,'equity_positions',entitlement.at);
    if(!evidence||evidence.id!==entitlement.observationId)return defer('missing_entitlement_evidence');
    if((await tx.query(`SELECT 1 FROM account_executions WHERE account_id=$1 AND occurred_at<=$2 AND attribution_state<>'completed'
     AND data->>'origin' IN ('agentic','drip') LIMIT 1`,[fill.account_id,entitlement.at])).rows.length)return defer('entitlement_history_pending');
    const position=evidence.data.filter(p=>equityRef(p)===instrumentRef);
    if(position.some(p=>p.currency!=='USD'||p.side==='short'))return defer('unsupported_entitlement_position');
    let held=position.reduce((sum,p)=>sum+amount(p.quantity),0n);
    for(const between of await fillsSince(tx,fill.account_id,evidence.observedAt,entitlement.at)){
     if(between.asset_class!=='equity'||equityRef(between.data)!==instrumentRef)continue;
     const change=fillAmounts(between);if(!change)return defer('entitlement_history_pending');
     held+=amount(change.quantityDelta);
    }
    const past=(await tx.query<{allocationId:string;attributedQuantity:string;status:string}>(`SELECT a.id AS "allocationId",a.status,sum(e.quantity_delta)::text AS "attributedQuantity"
     FROM strategy_allocations a JOIN strategy_attribution_entries e ON e.allocation_id=a.id
     WHERE a.account_id=$1 AND e.instrument_ref=$2 AND e.occurred_at<=$3 GROUP BY a.id HAVING sum(e.quantity_delta)>0 ORDER BY a.id`,[fill.account_id,instrumentRef,entitlement.at])).rows;
    const total=past.reduce((sum,p)=>sum+amount(p.attributedQuantity),0n);
    if(held<total||past.some(p=>p.status==='closed'||p.status==='detached'))return defer('entitlement_claims_unresolved');
    for(const share of splitReinvestedShares({quantity:fill.data.quantity,claims:past,heldQuantity:format(held)})){
     const transactionId=await instruction(tx,{allocationId:share.allocationId,kind:'reinvestment',cause:ref},now);
     await append(tx,{allocationId:share.allocationId,transactionId,entryType:'reinvestment',instrumentRef,symbol:fill.data.symbol,
      quantityDelta:share.quantity,cashDelta:'0',unitCost:fill.data.price,provider:fill.provider,executionRef:fill.provider_ref,cause:ref,
      sourceKind:'provider_execution',sourceRef:fill.provider_ref,occurredAt:at,metadata:{entitlementAt:entitlement.at,observationId:evidence.id}},now);
     await tx.query(`INSERT INTO strategy_evidence_pins(allocation_id,observation_id,reason) VALUES($1,$2,'entitlement') ON CONFLICT DO NOTHING`,[share.allocationId,evidence.id]);
    }
   }else if(fill.data.origin==='agentic'&&!context.memberDirected)return defer('missing_order_causation');
   else if(fill.data.side==='sell')await reconcile(tx,fill.account_id,instrumentRef,now);
   else if(!['user','recurring'].includes(fill.data.origin))return defer('unknown_order_origin');
   // External buys stay personal. No physical snapshot or fill payload is changed.
   await closeCase(tx,fill.account_id,scope,now);
   await tx.query(`UPDATE account_executions SET attribution_state='completed',attributed_at=$4 WHERE account_id=$1 AND provider=$2 AND provider_ref=$3`,[fill.account_id,fill.provider,fill.provider_ref,now]);
   return 'completed' as const;
  });},
  reconcile(accountId:string,instrumentRef:string|null,lots?:LotObservation){return atomic((tx,now)=>reconcile(tx,accountId,instrumentRef,now,lots));},
  keepReduced(caseId:string,lots?:LotObservation){return atomic((tx,now)=>keepReduced(tx,caseId,now,lots));},
  async cases(accountId:string){return database.use(async db=>(await db.query(`SELECT * FROM strategy_reconciliation_cases WHERE account_id=$1 ORDER BY created_at,id`,[accountId])).rows);},
  guardSelfDirected(input:{accountId:string;side:'buy'|'sell';amount:string;instrumentRef?:string;lotIds?:string[]}){return atomic(async(tx,now)=>{
   const requested=positive(input.amount);
   if(input.side==='buy'){
    if(requested>(await availableCash(tx,input.accountId,now)).available)throw new Error('Buy reaches allocation cash');
   }else{
    if(!input.instrumentRef)throw new Error('Instrument required');
    const m=await measuredShares(tx,input.accountId,input.instrumentRef,now);
    const reserved=(await claimed(tx,input.accountId,input.instrumentRef)).reduce((sum,c)=>sum+amount(c.quantity),0n);
    if(requested>m.quantity-reserved)throw new Error('Sale reaches allocation shares');
    if(input.lotIds?.length&&(await tx.query(`SELECT 1 FROM strategy_lot_bindings b JOIN strategy_attribution_entries e ON e.id=b.entry_id
     JOIN strategy_allocations a ON a.id=e.allocation_id WHERE b.account_id=$1 AND b.open_lot_id=ANY($2::text[]) AND a.status IN ${unreleased} LIMIT 1`,[input.accountId,input.lotIds])).rows.length)throw new Error('Lot belongs to an allocation');
   }
  });},
  resolveLots(input:{accountId:string;provider:string;instrumentRef:string;lots:RobinhoodTaxLot[];observedAt:string;complete:true}){return atomic(async(tx,now)=>{
   await validateLotEvidence(tx,input,now);
   const used=new Set((await tx.query<{open_lot_id:string}>(`SELECT open_lot_id FROM strategy_lot_bindings WHERE account_id=$1 AND provider=$2`,[input.accountId,input.provider])).rows.map(r=>r.open_lot_id));
   const entries=(await tx.query<{id:string;quantity:string;price:string;at:string}>(`SELECT e.id,e.quantity_delta::text AS quantity,e.unit_cost::text AS price,e.occurred_at::text AS at
    FROM strategy_attribution_entries e LEFT JOIN strategy_lot_bindings b ON b.entry_id=e.id
    WHERE e.account_id=$1 AND e.provider=$2 AND e.instrument_ref=$3 AND e.quantity_delta>0 AND e.unit_cost IS NOT NULL
    AND e.entry_type IN ('fill','reinvestment') AND b.entry_id IS NULL ORDER BY e.occurred_at,e.sequence,e.id`,[input.accountId,input.provider,input.instrumentRef])).rows;
   let matched=0;
   for(const entry of entries){
    const lot=matchFillToLot(input.lots,{quantity:entry.quantity,price:entry.price,occurredAt:entry.at},used);
    if(lot===null)continue;
    await tx.query(`INSERT INTO strategy_lot_bindings(entry_id,account_id,provider,open_lot_id,matched_at) VALUES($1,$2,$3,$4,$5)`,[entry.id,input.accountId,input.provider,lot.openLotId,now]);used.add(lot.openLotId);matched++;
   }
   return {matched,unmatched:entries.length-matched};
  });},
  lotsForSale(input:{allocationId:string;instrumentRef:string;quantity:string;provider:string;lots:RobinhoodTaxLot[];observedAt:string;complete:true}){return atomic(async(tx,now)=>{
   const requested=positive(input.quantity),a=await allocation(tx,input.allocationId);
   await validateLotEvidence(tx,{...input,accountId:a.account_id},now);
   if(a.status!=='active'||a.restore_required)throw new Error('Allocation cannot place orders');
   const h=await holdings(tx,a.id);
   if(requested>amount(h.positions.find(p=>p.instrumentRef===input.instrumentRef)?.quantity??'0'))throw new Error('Sale exceeds allocation shares');
   const measured=await measuredShares(tx,a.account_id,input.instrumentRef,now);
   const total=(await claimed(tx,a.account_id,input.instrumentRef)).reduce((sum,c)=>sum+amount(c.quantity),0n);
   if(measured.quantity<total)throw new Error('Account no longer covers allocation claims');
   const bindings=(await tx.query<{allocation_id:string;open_lot_id:string}>(`SELECT e.allocation_id,b.open_lot_id FROM strategy_lot_bindings b
    JOIN strategy_attribution_entries e ON e.id=b.entry_id JOIN strategy_allocations a ON a.id=e.allocation_id
    WHERE a.account_id=$1 AND b.provider=$2 AND e.instrument_ref=$3 AND a.status IN ${unreleased}`,[a.account_id,input.provider,input.instrumentRef])).rows;
   const own=new Set(bindings.filter(b=>b.allocation_id===a.id).map(b=>b.open_lot_id));
   const claimedLots=new Set(bindings.map(b=>b.open_lot_id));
   const available=input.lots.filter(l=>l.selectable!==false);
   const selected=selectLotsForSale(available,own,input.quantity);
   if(!selected.covered&&input.lots.some(l=>own.has(l.openLotId)&&l.selectable===false))throw new Error('Allocation lots are not selectable yet');
   return selectLotsWithFallback(available,own,new Set(available.filter(l=>!claimedLots.has(l.openLotId)).map(l=>l.openLotId)),input.quantity);
  });},
  detach(input:{allocationId:string;cause:string}){return atomic(async(tx,now)=>{
   const a=await allocation(tx,input.allocationId);
   const transactionId=await instruction(tx,{allocationId:a.id,kind:'detachment',cause:input.cause},now);
   if(a.status==='detached')return;
   if(a.status==='closed')throw new Error('Allocation already closed');
   await noOpenOrders(tx,a.account_id,a.id);if(a.restore_required)throw new Error('Restore reconciliation required');
   const h=await holdings(tx,a.id);
   if(amount(h.cash)<0n||h.positions.some(p=>amount(p.quantity)<0n))throw new Error('Resolve negative ledger before detaching');
   for(const p of h.positions){if(amount(p.quantity)===0n)continue;
    await append(tx,{allocationId:a.id,transactionId,entryType:'detachment',instrumentRef:p.instrumentRef,symbol:p.symbol,quantityDelta:format(-amount(p.quantity)),cause:`${input.cause}:${p.instrumentRef}`,sourceKind:'member_instruction',sourceRef:transactionId,occurredAt:now},now);
   }
   if(amount(h.cash)!==0n)await append(tx,{allocationId:a.id,transactionId,entryType:'capital_released',cashDelta:format(-amount(h.cash)),cause:`${input.cause}:cash`,sourceKind:'member_instruction',sourceRef:transactionId,occurredAt:now},now);
   await tx.query(`UPDATE strategy_allocations SET status='detached',updated_at=$2 WHERE id=$1`,[a.id,now]);
   await reconcile(tx,a.account_id,null,now);
   for(const p of h.positions)await reconcile(tx,a.account_id,p.instrumentRef,now);
   await refreshStatuses(tx,a.account_id,now);
  });},
  read(allocationId:string){return atomic(async(tx,now)=>{
   const a=await allocation(tx,allocationId);const h=await holdings(tx,a.id);
   const snap=await observation<NormalizedRobinhoodPosition[]>(tx,a.account_id,'equity_positions',now);
   // Key the pure hosted functions by canonical instrument ID, not ticker.
   const valuation=deriveAllocationValuation({cashUsd:h.cash,positions:h.positions.map(p=>({symbol:p.instrumentRef,quantity:p.quantity})),
    snapshot:(snap?.data??[]).map(p=>({...p,symbol:p.instrumentRef}))});
   const entries=(await tx.query<{sequence:number;entryType:string;symbol:string|null;quantityDelta:string|null;cashDelta:string}>(`SELECT sequence,entry_type AS "entryType",instrument_ref AS symbol,quantity_delta::text AS "quantityDelta",cash_delta::text AS "cashDelta" FROM strategy_attribution_entries WHERE allocation_id=$1 ORDER BY sequence`,[a.id])).rows;
   return {allocation:a,holdings:h,valuation,pnl:deriveAllocationPnl(entries),observedAt:snap?.observedAt??null,stale:!snap||Date.parse(now)-Date.parse(snap.observedAt)>15*60_000};
  });},
 };
}
