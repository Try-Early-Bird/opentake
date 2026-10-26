import {cryptoRejectionDiagnostic} from './crypto-rejection';
import {cryptoOrderStatusReason} from '../../shared/crypto-orders';
import {cryptoReviewStep} from './crypto-review-error';
import {cryptoPreviewInput} from './crypto-preview-contract';
import {z} from 'zod';
import {amount,format} from '../allocations/ledger';
import type {createDatabaseLifecycle} from '../database';
import type {CryptoOrderRequest,CryptoOrderResult,CryptoOrderView} from '../../shared/crypto-orders';
import type {CryptoTransport} from './crypto-transport';
import {createCryptoOrderJournal} from './crypto-journal';
import {createCryptoOrderExecution} from './crypto-execution';
import {createCryptoCashSettlement} from './crypto-cash-settlement';
import {createCryptoFillSettlement} from './crypto-fill-settlement';
import {classifyRobinhoodCryptoCancellation} from './robinhood-crypto-adapter';

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
const command=z.discriminatedUnion('action',[
 z.object({action:z.literal('status')}).strict(),
 z.object({action:z.literal('list')}).strict(),
 z.object({action:z.literal('review'),order:z.unknown()}).strict(),
 z.object({action:z.enum(['confirm','refresh','cancel']),id:z.uuid()}).strict(),
]);
/** Explicit member-operated limit-buy flow. No chat tool or scheduler can submit it.
 * Full fills retain cash holds until balance settlement is integrated. */
export function createCryptoTradingService(database:Database,deps:{
 enabled():boolean;
 selected():Promise<string>;
 synchronize?():Promise<unknown>;
 session<T>(accountId:string,work:(session:CryptoTransport)=>Promise<T>):Promise<T>;
}){
 const journal=createCryptoOrderJournal(database),fills=createCryptoFillSettlement(database),cash=createCryptoCashSettlement(database);
 async function views(accountId:string,id?:string):Promise<CryptoOrderView[]>{
  return database.use(async db=>(await db.query<any>(`SELECT i.*,a.masked_number,a.nickname,h.state AS hold_state,f.snapshot FROM order_intents i JOIN linked_accounts a ON a.id=i.account_id
   LEFT JOIN order_cash_holds h ON h.intent_id=i.id LEFT JOIN order_fill_checkpoints f ON f.intent_id=i.id
   WHERE i.account_id=$1 AND i.asset_class='crypto' AND ($2::uuid IS NULL OR i.id=$2) ORDER BY i.reviewed_at DESC LIMIT 50`,[accountId,id??null])).rows.map(row=>({
    id:row.id,accountId:row.account_id,accountLabel:[row.nickname,row.masked_number].filter(Boolean).join(' · '),symbol:z.object({symbol:z.string()}).parse(row.review_result).symbol,
    status:row.status,statusReason:[cryptoOrderStatusReason(row.status,row.error_code),row.status==='rejected'&&cryptoRejectionDiagnostic(row.placement_result?.rejectionDiagnostic)?'Robinhood error: '+cryptoRejectionDiagnostic(row.placement_result.rejectionDiagnostic):null].filter(Boolean).join(' ')||null,providerState:row.snapshot?.state??null,approvalPending:row.status==='approval_pending',
    order:row.order_request as CryptoOrderRequest,maximumDebit:format(amount(String(row.maximum_debit))),filledQuantity:row.snapshot?.filled??'0',
    netCash:row.snapshot?.netCash??'0',cashHeld:row.hold_state==='held',expiresAt:new Date(row.expires_at).toISOString(),
   })));
 }
 return {
  recover:()=>journal.recoverInterrupted(),
  async execute(raw:unknown):Promise<CryptoOrderResult>{
   const input=command.parse(raw),enabled=deps.enabled();
   if(input.action==='status')return {enabled,orders:[]};
   if(input.action==='review'&&!cryptoPreviewInput.safeParse(input.order).success)throw Error('Enter a positive USD amount and limit price using decimal numbers');
   const accountId=await (input.action==='review'?cryptoReviewStep('account',()=>deps.selected()):deps.selected());
   if(input.action==='list')return {enabled,orders:await views(accountId)};
   if(input.action==='review'){
    if(!enabled)throw Error('Crypto trading is currently disabled');
    const prepared=await cryptoReviewStep('provider',()=>deps.session(accountId,s=>s.review(input.order)));
    const intent=await cryptoReviewStep('save',()=>journal.review({accountId,order:prepared.order,maximumDebit:prepared.maximumDebit,review:prepared.preview}));
    return {enabled,orders:await cryptoReviewStep('display',()=>views(accountId,intent.id))};
   }
   const intent=await journal.get(input.id);
   if(intent.account_id!==accountId)throw Error('Select the order’s original account');
   if(intent.allocation_id!==null)throw Error('Use the Take’s instruction to manage this order');
   if(input.action==='confirm'){
    if(!enabled)throw Error('Crypto trading is currently disabled');
    await deps.session(accountId,session=>createCryptoOrderExecution(journal,{
     enabled:deps.enabled,prepare:row=>session.prepare(row),authorize:async(_tx,row)=>{
      if(row.allocation_id!==null)throw Error('Manual confirmation cannot submit a Take order');
      // The journal atomically checks selected connected account and unclaimed cash.
     },
    }).confirm(intent.id));
   }else if(input.action==='refresh'){
    const evidence=await deps.session(accountId,session=>session.observe(intent));
    if(['placement_unknown','approval_pending'].includes(intent.status))await journal.reconcile(intent.id,evidence);
    const current=await journal.get(intent.id);
    if(current.status==='placed'){
     const matches=evidence.read.orders.filter((row:any)=>row?.id===current.provider_order_ref);
     if(matches.length!==1)throw Error('Order evidence is missing or ambiguous; funds remain reserved');
     const observed=await fills.observe({intentId:intent.id,accountId,observedAt:evidence.observedAt,order:matches[0]});
     if(observed.snapshot.terminal&&amount(observed.snapshot.filled)===0n&&deps.synchronize){
      // The venue session has settled before starting account synchronization.
      // A blocked release is conservative and remains visible as cashHeld.
      await deps.synchronize();
      await cash.releaseUnfilled({intentId:intent.id,accountId}).catch(()=>{});
     }
    }
   }else{
    // Cancellation is available even with new trading disabled. Acknowledgment is
    // never treated as a fill, terminal state, or permission to release cash.
    let cancellation:'requested'|'rejected'|'unknown';
    try{cancellation=classifyRobinhoodCryptoCancellation(await deps.session(accountId,s=>s.cancel(intent)));}
    catch{cancellation='unknown';}
    return {enabled,orders:await views(accountId,intent.id),cancellation};
   }
   return {enabled,orders:await views(accountId,intent.id)};
  },
 };
}
