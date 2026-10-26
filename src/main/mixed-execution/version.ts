import type {Transaction} from '@electric-sql/pglite';
import {basketSchema} from '../../shared/strategies';
/** Called within Coinbase's reviewed adoption transaction, after its evidence checks.
 * The same decision pins both accounts; accepting one half is never possible. */
export async function adoptMixedVersion(tx:Transaction,takeId:string,from:string,to:string){
 const row=(await tx.query<{id:string;strategy_id:string;accepted_version_id:string;status:string;restore_required:boolean;spec:unknown;sequence:number}>(`SELECT a.id,a.strategy_id,a.accepted_version_id,a.status,a.restore_required,v.spec,v.sequence
 FROM takes t JOIN strategy_allocations a ON a.strategy_id=t.strategy_id
 JOIN strategy_account_routes r ON r.strategy_id=a.strategy_id AND r.account_id=a.account_id AND r.venue='robinhood'
 JOIN strategy_versions v ON v.strategy_id=t.strategy_id AND v.id=$2
 WHERE t.id=$1 AND a.status IN ('active','paused','diverged') FOR UPDATE OF a`,[takeId,to])).rows[0];
 if(!row||row.restore_required||!['active','paused'].includes(row.status)||row.accepted_version_id!==from)throw Error('Reconcile both accounts on the same version before switching.');
 const venues=new Set(basketSchema.parse(row.spec).target.weights.map(w=>w.instrument.venue));
 if(venues.size!==2||!venues.has('coinbase')||!venues.has('robinhood'))throw Error('Keep both platforms in this funded Take. Close its holdings before removing a platform.');
 if((await tx.query(`SELECT 1 FROM mixed_take_executions WHERE take_id=$1 AND state<>'completed'
 UNION ALL SELECT 1 FROM strategy_executions WHERE allocation_id=$2 AND status NOT IN ('filled','cancelled','failed')
 UNION ALL SELECT 1 FROM strategy_allocation_transactions WHERE allocation_id=$2 AND outcome IS NULL AND pending_reason IS NOT NULL
 UNION ALL SELECT 1 FROM strategy_allocation_closures WHERE allocation_id=$2 AND status IN ('awaiting','selling','failed') LIMIT 1`,[takeId,row.id])).rows.length)throw Error('Wait for investment actions on both platforms to finish before switching.');
 await tx.query('UPDATE strategy_allocations SET accepted_version_id=$2,applied_version_id=$2,applied_version_sequence=$3,last_drift_check_on=NULL,planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=now() WHERE id=$1',[row.id,to,row.sequence]);
}
