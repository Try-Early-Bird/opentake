import {mixedLegFinished} from '../../shared/mixed-execution';
import type {Transaction} from '@electric-sql/pglite';
import type {createDatabaseLifecycle} from '../database';
import type {MixedPreview,MixedVenue} from '../../shared/mixed-execution';
import type {MixedExecution,MixedExecutionLeg,MixedExecutionStore} from './coordinator';
type Query=Pick<Transaction,'query'>;
async function read(db:Query,id:string):Promise<MixedExecution|null>{
 const row=(await db.query<{id:string;take_id:string;preview_id:string;state:MixedExecution['state']}>('SELECT * FROM mixed_take_executions WHERE id=$1',[id])).rows[0];
 if(!row)return null;
 const legs=(await db.query<MixedExecutionLeg>('SELECT venue,account_id AS "accountId",operation_id AS "operationId",reference,state,message FROM mixed_take_execution_legs WHERE execution_id=$1 ORDER BY venue',[id])).rows;
 return {id:row.id,takeId:row.take_id,previewId:row.preview_id,state:row.state,legs};
}
/** Venue funders reuse the existing ledger services on this same transaction.
 * They must create held instructions: neither background worker may dispatch a
 * child until the coordinator explicitly activates it after commit. */
export function createMixedExecutionStore(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>,deps:{
 validate(tx:Transaction,preview:MixedPreview):Promise<void>;
 reserve(tx:Transaction,preview:MixedPreview,leg:{venue:MixedVenue;accountId:string;operationId:string}):Promise<string>;
},clock=Date.now):MixedExecutionStore {
 return {
  find:id=>database.use(db=>read(db,id)),
  fund:(id,preview,legs)=>database.use(db=>db.transaction(async tx=>{
   await tx.query('SELECT id FROM takes WHERE id=$1 FOR UPDATE',[preview.takeId]);
   const prior=await read(tx,id);
   if(prior){if(prior.previewId!==preview.id)throw Error('Investment request changed.');return prior;}
   const persisted=(await tx.query<{payload:MixedPreview;expires_at:Date}>('SELECT payload,expires_at FROM mixed_take_previews WHERE id=$1 FOR UPDATE',[preview.id])).rows[0];
   if(!persisted||persisted.payload.takeId!==preview.takeId||persisted.payload.versionId!==preview.versionId||persisted.payload.routeRevision!==preview.routeRevision||persisted.payload.amountUsd!==preview.amountUsd)throw Error('Investment review changed.');
   if(persisted.expires_at.getTime()<=clock())throw Error('Review expired. Preview again.');
   if(!persisted.payload.executionEnabled||persisted.payload.state==='blocked'||legs.length<2||legs.length!==persisted.payload.legs.length||new Set(legs.map(l=>l.venue)).size!==legs.length||new Set(legs.map(l=>l.accountId)).size!==legs.length)throw Error('Mixed investment is not ready.');
   await deps.validate(tx,persisted.payload);
   await tx.query("INSERT INTO mixed_take_executions(id,take_id,preview_id,state) VALUES($1,$2,$3,'funded')",[id,preview.takeId,preview.id]);
   for(const leg of legs){
    const expected=persisted.payload.legs.find(l=>l.venue===leg.venue);
    if(!expected||expected.accountId!==leg.accountId)throw Error('Funding account changed.');
    const reference=await deps.reserve(tx,persisted.payload,leg);
    if(!reference)throw Error('Missing durable venue instruction.');
    await tx.query("INSERT INTO mixed_take_execution_legs(execution_id,venue,account_id,operation_id,reference,state) VALUES($1,$2,$3,$4,$5,'reserved')",[id,leg.venue,leg.accountId,leg.operationId,reference]);
   }
   return (await read(tx,id))!;
  })),
  claimDispatch:(id,leg)=>database.use(db=>db.transaction(async tx=>{
   const result=await tx.query("UPDATE mixed_take_execution_legs SET state='dispatching',message=NULL WHERE execution_id=$1 AND venue=$2 AND account_id=$3 AND operation_id=$4 AND reference=$5 AND state='reserved' RETURNING venue",[id,leg.venue,leg.accountId,leg.operationId,leg.reference]);
   if(result.rows.length)await tx.query("UPDATE mixed_take_executions SET state='running',updated_at=now() WHERE id=$1",[id]);
   return result.rows.length===1;
  })),
  saveLeg:(id,leg)=>database.use(db=>db.transaction(async tx=>{
   await tx.query('SELECT id FROM mixed_take_executions WHERE id=$1 FOR UPDATE',[id]);
   const result=await tx.query('UPDATE mixed_take_execution_legs SET state=$5,message=$6 WHERE execution_id=$1 AND venue=$2 AND account_id=$3 AND operation_id=$4 AND reference=$7 RETURNING venue',[id,leg.venue,leg.accountId,leg.operationId,leg.state,leg.message,leg.reference]);
   if(!result.rows.length)throw Error('Investment leg identity changed.');
   const run=(await read(tx,id))!;
   const state=run.legs.every(l=>mixedLegFinished(l.state))?'completed':run.legs.some(l=>l.state==='attention')?'attention':run.legs.every(l=>l.state==='reserved')?'funded':'running';
   await tx.query('UPDATE mixed_take_executions SET state=$2,updated_at=now() WHERE id=$1',[id,state]);
   return {...run,state};
  })),
 };
}
