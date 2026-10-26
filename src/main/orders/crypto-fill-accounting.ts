import {z} from 'zod';
import {cryptoDecimal} from './crypto-preview-contract';
import {amount,format,fingerprint} from '../allocations/ledger';

const decimal=cryptoDecimal.transform(value=>format(amount(value)));
const positive=decimal.refine(value=>amount(value)>0n);
const timestamp=z.string().datetime({offset:true}).transform(value=>new Date(value).toISOString());
const id=z.string().min(1).max(256);
const execution=z.object({id,quantity:positive,price:decimal,effective_price:decimal,notional:decimal,timestamp});
const schema=z.object({id,ref_id:id,currency_pair_id:id,side:z.enum(['buy','sell']),
 state:z.enum(['new','queued','unconfirmed','confirmed','partially_filled','filled','canceled','rejected','failed','voided']),
 quantity:positive,limit_price:decimal.nullish(),cumulative_quantity:decimal,updated_at:timestamp,speculative:z.boolean().optional(),
 net_rounded_executed_notional:decimal.nullish(),fee:decimal.nullish(),
 tax_withholding:z.object({total_withholding_amount:decimal.nullish(),estimated_withholding_amount:decimal.nullish()}).nullish(),
 executions:z.array(execution).max(10000).nullable()});
const terminalStates=new Set(['filled','canceled','rejected','failed','voided']);
export interface CryptoFillSnapshot {
 orderRef:string;clientRef:string;pairId:string;side:'buy'|'sell';state:string;terminal:boolean;
 quantity:string;filled:string;netCash:string;fee:string|null;withholding:string|null;updatedAt:string;
 executions:z.infer<typeof execution>[];
}
/** Provider net executed cash already includes all fees and withholding. Never
 * substitute preview/gross totals or reconstruct it from rounded per-fill prices. */
export function normalizeCryptoFillSnapshot(raw:unknown,expected:{orderRef:string;pairId:string;side:'buy'|'sell';clientRefs:readonly string[];quantity?:string;limitPrice?:string}):CryptoFillSnapshot{
 const row=schema.parse(raw);
 if(row.id!==expected.orderRef||row.currency_pair_id!==expected.pairId||row.side!==expected.side||!expected.clientRefs.includes(row.ref_id)||row.speculative===true)throw Error('Crypto fill identity mismatch');
 if(expected.quantity&&amount(row.quantity)!==amount(expected.quantity))throw Error('Crypto order quantity changed');
 if(expected.limitPrice&&(row.limit_price==null||amount(row.limit_price)!==amount(expected.limitPrice)))throw Error('Crypto limit price changed');
 const fills=row.executions??[],ids=new Set<string>();let filled=0n;
 for(const fill of fills){
  if(ids.has(fill.id))throw Error('Duplicate crypto execution');ids.add(fill.id);
  if(Date.parse(fill.timestamp)>Date.parse(row.updated_at))throw Error('Execution is newer than order evidence');
  filled+=amount(fill.quantity);
 }
 if(filled!==amount(row.cumulative_quantity)||filled>amount(row.quantity))throw Error('Incomplete crypto execution evidence');
 if(row.state==='filled'&&filled!==amount(row.quantity))throw Error('Filled order quantity mismatch');
 if(row.state==='partially_filled'&&(filled===0n||filled===amount(row.quantity)))throw Error('Partial order quantity mismatch');
 if(filled>0n&&row.net_rounded_executed_notional==null)throw Error('Executed net cash evidence required');
 if(filled===0n&&amount(row.net_rounded_executed_notional??'0')!==0n)throw Error('Cash without crypto fills requires reconciliation');
 const withholding=row.tax_withholding?.total_withholding_amount??null;
 if(filled>0n&&row.tax_withholding&&(withholding===null||row.tax_withholding.estimated_withholding_amount!=null))throw Error('Actual withholding evidence required');
 return {orderRef:row.id,clientRef:row.ref_id,pairId:row.currency_pair_id,side:row.side,state:row.state,terminal:terminalStates.has(row.state),
  quantity:row.quantity,filled:row.cumulative_quantity,netCash:row.net_rounded_executed_notional??'0',
  // A pre-fill fee is an estimate, not an amount to book.
  fee:filled>0n?row.fee??null:null,withholding,updatedAt:row.updated_at,executions:[...fills].sort((a,b)=>a.id.localeCompare(b.id))};
}
/** Delta between durably accepted cumulative observations. Persist the snapshot
 * and the ledger delta atomically. Repeated observations produce zero delta.
 * terminal is provider evidence only; release also requires reconciled account cash. */
export function cryptoFillDelta(previous:CryptoFillSnapshot|null,next:CryptoFillSnapshot){
 if(previous){
  for(const key of ['orderRef','clientRef','pairId','side','quantity'] as const)if(previous[key]!==next[key])throw Error('Crypto accounting identity changed');
  if(Date.parse(next.updatedAt)<Date.parse(previous.updatedAt))throw Error('Stale crypto order evidence');
  if(Date.parse(next.updatedAt)===Date.parse(previous.updatedAt)&&fingerprint(previous)!==fingerprint(next))throw Error('Conflicting crypto evidence at the same revision');
  const current=new Map(next.executions.map(fill=>[fill.id,fill]));
  for(const fill of previous.executions)if(!current.has(fill.id)||fingerprint(current.get(fill.id))!==fingerprint(fill))throw Error('Crypto execution changed or disappeared');
  if(previous.terminal&&fingerprint({...previous,updatedAt:next.updatedAt})!==fingerprint(next))throw Error('Terminal crypto order changed');
 }
 const quantity=amount(next.filled)-amount(previous?.filled??'0'),cash=amount(next.netCash)-amount(previous?.netCash??'0');
 if(quantity<0n||cash<0n)throw Error('Crypto cumulative amounts regressed');
 return {quantityDelta:format(next.side==='buy'?quantity:-quantity),cashDelta:format(next.side==='buy'?-cash:cash),
  // Informational fee/withholding are retained on the snapshot. They are NOT
  // separate cash debits: the authoritative net delta already includes them.
  terminal:next.terminal,changed:previous===null||fingerprint(previous)!==fingerprint(next)};
}
