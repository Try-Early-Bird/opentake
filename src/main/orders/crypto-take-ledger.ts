import {ownedCryptoInstrument} from './crypto-take-identity';
import type {Transaction} from '@electric-sql/pglite';
import type {CryptoIntentRow} from './crypto-journal';
import type {CryptoFillSnapshot,cryptoFillDelta} from './crypto-fill-accounting';
import {allocation,append,amount,holdings} from '../allocations/ledger';
import {openCase} from '../allocations/reconciliation';
import {instrumentKey,type BasketSpec} from '../../shared/strategies';

/** Uses the existing Take attribution ledger and exact strategy instrument key.
 * Personal trades do not acquire a Take claim. Cumulative net cash already
 * includes fees/withholding, so no separate fee entry is appended. */
export async function applyCryptoTakeFill(tx:Transaction,input:{intent:CryptoIntentRow;snapshot:CryptoFillSnapshot;delta:ReturnType<typeof cryptoFillDelta>;cause:string},now:string){
 const {intent,snapshot,delta,cause}=input;
 if(intent.provider_order_ref!==snapshot.orderRef||intent.order_request.currency_pair_id!==snapshot.pairId||intent.order_request.side!==snapshot.side)throw Error('Crypto ledger causation mismatch');
 if(intent.allocation_id===null){if(intent.transaction_id!==null)throw Error('Invalid personal order causation');return;}
 if(!intent.transaction_id)throw Error('Take fill requires its original instruction');
 const a=await allocation(tx,intent.allocation_id);
 if(a.account_id!==intent.account_id||a.restore_required)throw Error('Take fill account requires reconciliation');
 const row=(await tx.query<{spec:BasketSpec}>(`SELECT v.spec FROM strategy_versions v JOIN strategy_allocation_transactions t ON t.allocation_id=$1
  WHERE v.id=coalesce((SELECT e.version_id FROM strategy_executions e WHERE e.order_intent_id=$6 AND e.allocation_id=$1 AND e.account_id=$7 AND e.transaction_id=$4),$2::uuid) AND v.strategy_id=$3 AND t.id=$4 AND t.created_at<=$5`,[a.id,a.applied_version_id,a.strategy_id,intent.transaction_id,snapshot.updatedAt,intent.id,intent.account_id])).rows[0];
 const matches=row?.spec.target.weights.filter(w=>w.instrument.venue==='robinhood'&&w.instrument.market?.venue==='robinhood'
  &&w.instrument.market.instance==='production'&&w.instrument.market.kind==='crypto'&&w.instrument.market.reference===snapshot.pairId)??[];
 const instrument=matches.length===1?matches[0]!.instrument:snapshot.side==='sell'?await ownedCryptoInstrument(tx,a.id,snapshot.pairId,false):null;
 if(!row||!instrument)throw Error('Crypto fill has no original Take identity');
 const ref=instrumentKey(instrument);
 await append(tx,{allocationId:a.id,transactionId:intent.transaction_id,entryType:'fill',cause,
  instrumentRef:ref,assetClass:'crypto',symbol:instrument.symbol,quantityDelta:delta.quantityDelta,cashDelta:delta.cashDelta,
  sourceKind:'provider_order_cumulative',sourceRef:snapshot.orderRef,occurredAt:snapshot.updatedAt,
  metadata:{intentId:intent.id,pairId:snapshot.pairId,executionIds:snapshot.executions.map(e=>e.id),netCash:snapshot.netCash,fee:snapshot.fee,withholding:snapshot.withholding}},now);
 const current=await holdings(tx,a.id);
 if(amount(current.cash)<0n||current.positions.some(p=>amount(p.quantity)<0n))await openCase(tx,{accountId:a.account_id,scope:`ledger:${a.id}`,
  cause:'negative_subledger_balance',impacts:[{allocationId:a.id,quantity:'0'}],evidence:{intentId:intent.id,orderRef:snapshot.orderRef}},now);
}
