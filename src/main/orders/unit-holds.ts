import {ownedCryptoInstrument} from './crypto-take-identity';
import type {Transaction} from '@electric-sql/pglite';
import {amount,holdings,positive} from '../allocations/ledger';
import {instrumentKey} from '../../shared/strategies';
import type {CryptoIntentRow} from './crypto-journal';
export interface CryptoSellAvailability {quantity:string;observedAt:string}
/** Shares the journal's account lock and transaction. A ticker is never ownership. */
export async function holdCryptoUnits(tx:Transaction,row:CryptoIntentRow,evidence:CryptoSellAvailability|undefined,now:string){
 if(!row.allocation_id||!row.transaction_id||row.order_request.side!=='sell'||!row.order_request.quantity)throw Error('A crypto sell requires a Take instruction and unit quantity');
 const observed=Date.parse(evidence?.observedAt??''),at=Date.parse(now);
 if(!evidence||!Number.isFinite(observed)||observed>at||at-observed>60000)throw Error('Fresh transferable crypto units required');
 const quantity=positive(row.order_request.quantity),transferable=amount(evidence.quantity);
 const a=(await tx.query<{id:string}>(`SELECT a.id FROM strategy_allocations a
  JOIN linked_accounts l ON l.id=a.account_id JOIN platform_connections c ON c.id=l.connection_id
  WHERE a.id=$1 AND a.account_id=$2 AND a.status='active' AND NOT a.restore_required
  AND l.selected AND l.available AND l.agentic_allowed AND c.status='connected' AND c.venue='robinhood' FOR UPDATE OF l,a`,[row.allocation_id,row.account_id])).rows[0];
 if(!a)throw Error('The reviewed Robinhood account or Take is no longer available');
 const instrument=await ownedCryptoInstrument(tx,row.allocation_id,row.order_request.currency_pair_id);
 if(!instrument)throw Error('Insufficient unreserved Take crypto units');
 const ref=instrumentKey(instrument);
 const reserved=(await tx.query<{total:string;owned:string}>(`SELECT coalesce(sum(quantity),0)::text AS total,coalesce(sum(quantity) FILTER(WHERE allocation_id=$3),0)::text AS owned FROM order_unit_holds WHERE account_id=$1 AND instrument_ref=$2 AND state='held'`,[row.account_id,ref,row.allocation_id])).rows[0];
 const owned=(await holdings(tx,row.allocation_id)).positions.find(p=>p.instrumentRef===ref)?.quantity??'0';
 if(quantity>amount(owned)-amount(reserved.owned))throw Error('Insufficient unreserved Take crypto units');
 if(quantity>transferable-amount(reserved.total))throw Error('Insufficient unreserved transferable crypto units');
 await tx.query(`INSERT INTO order_unit_holds(intent_id,account_id,allocation_id,instrument_ref,quantity,state,created_at) VALUES($1,$2,$3,$4,$5,'held',$6)`,[row.id,row.account_id,row.allocation_id,ref,row.order_request.quantity,now]);
}
