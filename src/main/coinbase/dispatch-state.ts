import {createCoinbaseAllocations} from './allocations';
import type {createDatabaseLifecycle} from '../database';
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
/** Only the allocation reconciler establishes provider identity and terminal fill completeness. */
export async function reconcileDispatches(database:Database,accountId:string,clock=Date.now){
 await database.use(db=>db.transaction(async tx=>{
  await tx.query('SELECT id FROM linked_accounts WHERE id=$1 FOR UPDATE',[accountId]);
  await tx.query(`UPDATE coinbase_order_dispatches d SET state='accepted',updated_at=now() FROM coinbase_allocation_orders o WHERE o.id=d.order_id AND o.account_id=$1 AND o.provider_order_ref IS NOT NULL AND o.state IN ('bound','closed') AND d.state IN ('sending','unknown')`,[accountId]);
  await tx.query(`UPDATE coinbase_order_reviews r SET state='settled' WHERE r.account_id=$1 AND r.state='confirmed'
   AND (SELECT count(*) FROM coinbase_allocation_orders o WHERE o.account_id=r.account_id AND o.cause LIKE 'review:'||r.id::text||':%')=jsonb_array_length(r.payload->'orders')
   AND NOT EXISTS(SELECT 1 FROM coinbase_allocation_orders o WHERE o.account_id=r.account_id AND o.cause LIKE 'review:'||r.id::text||':%' AND o.state<>'closed')`,[accountId]);
 }));
 const withdrawals=await database.use(async db=>(await db.query<{id:string}>("SELECT r.id FROM coinbase_order_reviews r WHERE r.account_id=$1 AND r.state='settled' AND r.payload ? 'withdrawal' AND NOT EXISTS(SELECT 1 FROM coinbase_allocation_entries e WHERE e.cause='withdrawal-return:'||r.id::text)",[accountId])).rows);
 for(const row of withdrawals)await createCoinbaseAllocations(database,clock).returnWithdrawalProceeds(row.id);
}
