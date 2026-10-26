import type {createDatabaseLifecycle} from '../database';
import type {CryptoTransport} from './crypto-transport';
import {createCryptoOrderJournal,type CryptoIntentRow} from './crypto-journal';
import {createCryptoFillSettlement} from './crypto-fill-settlement';
import {createCryptoCashSettlement} from './crypto-cash-settlement';
/** Existing maintenance owns scheduling and connection queues. This reconciles
 * durable crypto intents only; it never places or retries an order. */
export function createCryptoOrderSync(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,deps:{
 session<T>(accountId:string,work:(session:CryptoTransport)=>Promise<T>):Promise<T>;
 refreshCash():Promise<unknown>;
},clock=Date.now){
 const journal=createCryptoOrderJournal(database,clock),fills=createCryptoFillSettlement(database,undefined,clock),cash=createCryptoCashSettlement(database,clock);
 return {async synchronize(accountId:string){
  const pending=(await database.use(db=>db.query<CryptoIntentRow>(`SELECT i.* FROM order_intents i WHERE account_id=$1 AND asset_class='crypto'
   AND (status IN ('placement_unknown','approval_pending') OR (status='placed' AND (EXISTS(SELECT 1 FROM order_cash_holds h WHERE h.intent_id=i.id AND h.state='held')
    OR EXISTS(SELECT 1 FROM order_unit_holds h WHERE h.intent_id=i.id AND h.state='held')
    OR NOT EXISTS(SELECT 1 FROM order_fill_checkpoints f WHERE f.intent_id=i.id AND (f.snapshot->>'terminal')::boolean))))
   ORDER BY reviewed_at,id`,[accountId]))).rows;
  const terminalBuys:string[]=[];
  for(const intent of pending){
   const observed=await deps.session(accountId,session=>session.observe(intent));
   if(['placement_unknown','approval_pending'].includes(intent.status))await journal.reconcile(intent.id,observed);
   const current=await journal.get(intent.id);
   if(current.status!=='placed')continue;
   const matches=observed.read.orders.filter((row:any)=>row?.id===current.provider_order_ref);
   if(matches.length!==1)throw Error('Crypto order evidence is missing or ambiguous');
   const result=await fills.observe({intentId:intent.id,accountId,observedAt:observed.observedAt,order:matches[0]});
   if(result.snapshot.terminal&&result.snapshot.side==='buy')terminalBuys.push(intent.id);
  }
  if(terminalBuys.length){
   // A balance read made before order reconciliation cannot release its hold.
   await deps.refreshCash();
   for(const intentId of terminalBuys){
    // A delayed balance or concurrent open order keeps the reservation intact;
    // maintenance will retry the read/settlement, never the submission.
    await cash.releaseSettled({intentId,accountId}).catch(()=>{});
   }
  }
 }};
}
