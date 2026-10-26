import {hasCryptoAccessDenial,ownedCryptoInstrument} from './crypto-take-identity';
import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import type {TakeOrderWriter} from '../execution/executor';
import type {CryptoTransport} from './crypto-transport';
import {createCryptoOrderJournal,type CryptoIntentRow} from './crypto-journal';
import {createCryptoOrderExecution} from './crypto-execution';
import {cryptoPreviewInput} from './crypto-preview-contract';
import {OrderConflictError,PlacementUnknownError} from './service';
import type {BasketSpec} from '../../shared/strategies';
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
/** An asset adapter for the existing Take executor, not another execution loop.
 * The caller owns confirmation policy and sequencing. Journal/dispatch still
 * own exactly-once claim, holds, account binding and uncertain recovery. */
export function createCryptoTakeWriter(database:Database,deps:{enabled():boolean;session<T>(accountId:string,work:(session:CryptoTransport)=>Promise<T>):Promise<T>},clock=Date.now):TakeOrderWriter {
 const journal=createCryptoOrderJournal(database,clock);
 async function authorize(tx:Pick<Transaction,'query'>,row:Pick<CryptoIntentRow,'account_id'|'allocation_id'|'transaction_id'|'order_request'>){
  if(!deps.enabled())throw new OrderConflictError('Crypto trading is not enabled');
  if(!row.allocation_id||!row.transaction_id)throw new OrderConflictError('Crypto Takes require their original instruction');
  const record=(await tx.query<{spec:BasketSpec}>(`SELECT v.spec FROM strategy_allocations a JOIN strategies s ON s.id=a.strategy_id
   JOIN strategy_versions v ON v.id=coalesce(a.accepted_version_id,a.applied_version_id) JOIN strategy_allocation_transactions t ON t.allocation_id=a.id
   WHERE a.id=$1 AND a.account_id=$2 AND t.id=$3 AND t.outcome IS NULL AND a.status='active' AND NOT a.restore_required
   AND (s.archived_at IS NULL OR ($4='sell' AND t.kind IN ('exit','redemption')))`,[row.allocation_id,row.account_id,row.transaction_id,row.order_request.side])).rows[0];
  const targets=record?.spec.target.weights.filter(w=>w.instrument.venue==='robinhood'&&w.instrument.market?.venue==='robinhood'
   &&w.instrument.market.instance==='production'&&w.instrument.market.kind==='crypto'&&w.instrument.market.reference===row.order_request.currency_pair_id)??[];
  if(!record)throw new OrderConflictError('Crypto Take instruction is no longer active');
  const owned=row.order_request.side==='sell'?await ownedCryptoInstrument(tx,row.allocation_id,row.order_request.currency_pair_id):null;
  if(row.order_request.side==='sell'?!owned:targets.length!==1)throw new OrderConflictError('Crypto order is not an accepted target or owned sell');
  const denied=await hasCryptoAccessDenial(tx,row.account_id);
  if(denied)throw new OrderConflictError('Robinhood previously denied agentic crypto access for this account. Eligibility must be resolved before trading.');
 }
 return {
  async review(input){
   const order=cryptoPreviewInput.parse(input.order);
   if(order.type!=='market')throw new OrderConflictError('Take orders use market execution');
   const scope={account_id:input.accountId,allocation_id:input.allocationId??null,transaction_id:input.transactionId??null,order_request:order};
   await database.use(tx=>authorize(tx,scope));
   const prepared=await deps.session(input.accountId,session=>session.review(order));
   const intent=await journal.review({accountId:input.accountId,allocationId:input.allocationId,transactionId:input.transactionId,order:prepared.order,maximumDebit:prepared.maximumDebit,review:prepared.preview});
   return {intent:{id:intent.id},review:prepared.preview};
  },
  async confirm(id){
   const intent=await journal.get(id);
   const result=await deps.session(intent.account_id,session=>createCryptoOrderExecution(journal,{enabled:deps.enabled,prepare:row=>session.prepare(row),authorize}).confirm(id));
   if(result.status==='rejected')throw new OrderConflictError('Robinhood rejected the crypto order');
   if(['placing','placement_unknown'].includes(result.status))throw new PlacementUnknownError('Crypto submission requires reconciliation');
   return {status:result.status,placedAt:null};
  },
 };
}
