import type {Transaction} from '@electric-sql/pglite';
import {basketSchema,assertBasketExecution} from '../../shared/strategies';
import type {TakeVersionReview} from '../../shared/take-version-review';
export async function readVersionReview(db:Pick<Transaction,'query'>,id:string):Promise<TakeVersionReview>{
 const r=(await db.query<{old_id:string;new_id:string;old_sequence:number;new_sequence:number;old_spec:unknown;new_spec:unknown}>(`SELECT v.id AS old_id,n.id AS new_id,v.sequence AS old_sequence,n.sequence AS new_sequence,v.spec AS old_spec,n.spec AS new_spec FROM strategy_allocations a JOIN strategies s ON s.id=a.strategy_id JOIN strategy_versions v ON v.id=a.accepted_version_id JOIN strategy_versions n ON n.id=s.current_version_id WHERE a.id=$1`,[id])).rows[0];
 if(!r)throw Error('Investment unavailable.');
 const before=basketSchema.parse(r.old_spec),after=basketSchema.parse(r.new_spec);
 return {versionId:r.old_id,currentVersionId:r.new_id,versionSequence:r.old_sequence,currentVersionSequence:r.new_sequence,currentWeights:before.target.weights.map(w=>({symbol:w.instrument.symbol,bps:w.bps})),nextWeights:after.target.weights.map(w=>({symbol:w.instrument.symbol,bps:w.bps})),currentRules:{...before.rebalance,cashBps:before.target.cashBps},nextRules:{...after.rebalance,cashBps:after.target.cashBps}};
}
export async function adoptVersion(tx:Transaction,id:string,from:string,to:string){
 const a=(await tx.query<{status:string;restore_required:boolean;archived:boolean}>(`SELECT a.status,a.restore_required,s.archived_at IS NOT NULL AS archived FROM strategy_allocations a JOIN strategies s ON s.id=a.strategy_id WHERE a.id=$1 FOR UPDATE OF a,s`,[id])).rows[0];
 if(!a||a.restore_required||a.archived||!['active','paused'].includes(a.status))throw Error('Reconcile or restore this investment before switching versions.');
 const review=await readVersionReview(tx,id);
 if(review.versionId!==from||review.currentVersionId!==to)throw Error('The Take changed. Review the latest version.');
 if((await tx.query(`SELECT 1 FROM strategy_executions WHERE allocation_id=$1 AND status NOT IN ('filled','cancelled','failed') UNION ALL SELECT 1 FROM strategy_allocation_transactions WHERE allocation_id=$1 AND outcome IS NULL AND pending_reason IS NOT NULL LIMIT 1`,[id])).rows.length)throw Error('Wait for pending investment actions to finish before switching versions.');
 if((await tx.query(`SELECT 1 FROM strategy_versions v JOIN strategies s ON s.current_version_id=v.id WHERE v.id=$1 AND v.source_proposal_id IS NOT DISTINCT FROM s.draft_revision_id`,[to])).rows.length===0)throw Error('Commit the latest changes first.');
 const target=(await tx.query<{spec:unknown}>('SELECT spec FROM strategy_versions WHERE id=$1',[to])).rows[0];
 assertBasketExecution(basketSchema.parse(target.spec));
 await tx.query(`UPDATE strategy_allocations SET accepted_version_id=$2,applied_version_id=$2,applied_version_sequence=$3,planning_reason_code=NULL,planning_deferred_until=NULL,updated_at=now() WHERE id=$1`,[id,to,review.currentVersionSequence]);
 return readVersionReview(tx,id);
}
