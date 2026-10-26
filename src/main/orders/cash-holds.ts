import type {Transaction} from '@electric-sql/pglite';
import {amount,format,holdings,positive} from '../allocations/ledger';
import {claimed,measuredCash} from '../allocations/evidence';

/** Take cash is already claimed in the allocation ledger; subtract only personal
 * holds from unallocated USD, otherwise Take reservations would be counted twice. */
export async function personalCashHeld(tx:Transaction,accountId:string):Promise<bigint>{
 const row=(await tx.query<{amount:string}>(`SELECT coalesce(sum(h.amount),0)::text AS amount
  FROM order_cash_holds h JOIN order_intents i ON i.id=h.intent_id
  WHERE i.account_id=$1 AND i.allocation_id IS NULL AND h.state='held'`,[accountId])).rows[0];
 return amount(row.amount);
}
/** A booked Take debit has reduced its ledger claim, but the account balance may
 * not reflect that debit yet. Keep it claimed until cash settlement releases the
 * hold. Even after a balance refresh this is deliberately conservative. */
export async function unsettledTakeCash(tx:Transaction,accountId:string):Promise<bigint>{
 const row=(await tx.query<{amount:string}>(`SELECT coalesce(sum((c.snapshot->>'netCash')::numeric),0)::text AS amount
  FROM order_cash_holds h JOIN order_intents i ON i.id=h.intent_id JOIN order_fill_checkpoints c ON c.intent_id=i.id
  WHERE i.account_id=$1 AND i.allocation_id IS NOT NULL AND h.state='held' AND c.snapshot->>'side'='buy'`,[accountId])).rows[0];
 return amount(row.amount);
}
/** Same transaction as the durable dispatch claim. No renderer-supplied balance. */
export async function holdOrderCash(tx:Transaction,input:{intentId:string;accountId:string;allocationId:string|null;maximumDebit:string},now:string){
 const debit=positive(input.maximumDebit);
 const account=(await tx.query(`SELECT a.id FROM linked_accounts a JOIN platform_connections c ON c.id=a.connection_id
  WHERE a.id=$1 AND a.available AND a.selected AND a.agentic_allowed AND c.status='connected' AND c.venue='robinhood'
  FOR UPDATE OF a`,[input.accountId])).rows[0];
 if(!account)throw Error('The reviewed Robinhood account is no longer available');
 // Until all legacy equity dispatches participate in holds, do not overlap them.
 if((await tx.query(`SELECT 1 FROM order_intents i WHERE account_id=$1 AND asset_class='equity'
  AND (status IN ('placing','placement_unknown') OR (status='placed' AND NOT EXISTS
   (SELECT 1 FROM account_orders o WHERE o.account_id=i.account_id AND o.provider='robinhood' AND o.provider_ref=i.provider_order_ref AND o.terminal))) LIMIT 1`,[input.accountId])).rows.length)throw Error('Wait for the existing equity submission to reconcile');
 if((await tx.query(`SELECT 1 FROM account_orders WHERE account_id=$1 AND NOT terminal LIMIT 1`,[input.accountId])).rows.length)throw Error('Wait for open account orders to settle');
 if((await tx.query(`SELECT 1 FROM account_executions WHERE account_id=$1 AND attribution_state<>'completed' LIMIT 1`,[input.accountId])).rows.length)throw Error('Wait for fill attribution to complete');
 const cash=(await measuredCash(tx,input.accountId,now)).cash;
 const claims=await claimed(tx,input.accountId,null);
 if(claims.some(c=>amount(c.quantity)<0n))throw Error('Resolve negative allocation cash');
 const personalRoom=cash-claims.reduce((sum,c)=>sum+amount(c.quantity),0n)-await personalCashHeld(tx,input.accountId)-await unsettledTakeCash(tx,input.accountId);
 if(personalRoom<0n)throw Error('Account cash no longer covers existing claims');
 let room=personalRoom;
 if(input.allocationId){
  const reserved=(await tx.query<{amount:string}>(`SELECT coalesce(sum(h.amount),0)::text AS amount
   FROM order_cash_holds h JOIN order_intents i ON i.id=h.intent_id
   WHERE i.account_id=$1 AND i.allocation_id=$2 AND h.state='held'`,[input.accountId,input.allocationId])).rows[0];
  room=amount((await holdings(tx,input.allocationId)).cash)-amount(reserved.amount);
 }
 if(debit>room)throw Error('Insufficient unreserved USD for the maximum order debit');
 await tx.query(`INSERT INTO order_cash_holds(intent_id,amount,state,created_at,cash_before) VALUES($1,$2,'held',$3,$4)`,[input.intentId,format(debit),now,format(cash)]);
}
