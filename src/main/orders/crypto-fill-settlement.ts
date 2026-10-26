import {applyCryptoTakeFill} from './crypto-take-ledger';
import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import {normalizeCryptoFillSnapshot,cryptoFillDelta,type CryptoFillSnapshot} from './crypto-fill-accounting';
import type {CryptoIntentRow} from './crypto-journal';
import {amount} from '../allocations/ledger';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Delta=ReturnType<typeof cryptoFillDelta>;
/** Internal transaction boundary, not registered with live sync yet. The caller's
 * ledger writer must record the net delta under cause once. Holds remain intact;
 * terminal order evidence alone is insufficient to release account cash. */
export function createCryptoFillSettlement(database:Database,deps:{
 applyDelta(tx:Transaction,input:{intent:CryptoIntentRow;snapshot:CryptoFillSnapshot;delta:Delta;cause:string}):Promise<void>;
}|undefined=undefined,clock=()=>Date.now()){
 return {async observe(input:{intentId:string;accountId:string;observedAt:string;order:unknown}){
  return database.use(db=>db.transaction(async tx=>{
   const at=new Date(clock()).toISOString(),observed=Date.parse(input.observedAt);
   if(!Number.isFinite(observed)||observed>clock()||clock()-observed>60000)throw Error('Fresh crypto order observation required');
   const intent=(await tx.query<CryptoIntentRow>(`SELECT *,maximum_debit::text FROM order_intents
    WHERE id=$1 AND account_id=$2 AND asset_class='crypto' FOR UPDATE`,[input.intentId,input.accountId])).rows[0];
   if(!intent||intent.status!=='placed'||!intent.provider_order_ref||!intent.confirmed_at)throw Error('A bound crypto intent is required');
   if(observed<new Date(intent.confirmed_at).getTime())throw Error('Crypto observation predates submission');
   const snapshot=normalizeCryptoFillSnapshot(input.order,{orderRef:intent.provider_order_ref,pairId:intent.order_request.currency_pair_id,
    side:intent.order_request.side,quantity:intent.order_request.quantity,limitPrice:intent.order_request.limit_price,clientRefs:[intent.ref_id,...(intent.approval_ref?[intent.approval_ref]:[])]});
   if(Date.parse(snapshot.updatedAt)>observed)throw Error('Order revision is newer than observation');
   // An over-cap fill is a real financial discrepancy; retain evidence externally
   // for reconciliation, never silently consume another Take's allocation.
   if(snapshot.side==='buy'&&amount(snapshot.netCash)>amount(intent.maximum_debit))throw Error('Crypto fill exceeds reserved debit; reconciliation required');
   const prior=(await tx.query<{snapshot:CryptoFillSnapshot;revision:number;observed_at:Date}>(`SELECT * FROM order_fill_checkpoints WHERE intent_id=$1`,[intent.id])).rows[0];
   if(prior&&observed<new Date(prior.observed_at).getTime())throw Error('Stale crypto observation');
   const delta=cryptoFillDelta(prior?.snapshot??null,snapshot);
   if(!delta.changed){
    await tx.query('UPDATE order_fill_checkpoints SET observed_at=$2,updated_at=$3 WHERE intent_id=$1',[intent.id,input.observedAt,at]);
    return {snapshot,delta,revision:prior!.revision};
   }
   const revision=(prior?.revision??0)+1;
   if(amount(delta.quantityDelta)!==0n||amount(delta.cashDelta)!==0n){
    const entry={intent,snapshot,delta,cause:`crypto-order:${intent.id}:${revision}`};
    if(deps)await deps.applyDelta(tx,entry);else await applyCryptoTakeFill(tx,entry,at);
   }
   await tx.query(`INSERT INTO order_fill_checkpoints(intent_id,snapshot,revision,observed_at,updated_at) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(intent_id) DO UPDATE SET snapshot=excluded.snapshot,revision=excluded.revision,observed_at=excluded.observed_at,updated_at=excluded.updated_at`,
    [intent.id,JSON.stringify(snapshot),revision,input.observedAt,at]);
   if(snapshot.side==='sell'&&snapshot.terminal)await tx.query(`UPDATE order_unit_holds SET state='released',released_at=$2 WHERE intent_id=$1 AND state='held'`,[intent.id,at]);
   return {snapshot,delta,revision};
  }));
 }};
}
