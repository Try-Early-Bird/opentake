import type {createDatabaseLifecycle} from '../database';
import type {MixedPreview} from '../../shared/mixed-execution';
import type {MixedPreviewStore} from './preview';
/** Review journal only: no allocations, reservations, or orders are created here. */
export function createMixedPreviewStore(database:Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>):MixedPreviewStore{
 return {
  find:operationId=>database.use(async db=>{const row=(await db.query<{request_hash:string;payload:MixedPreview}>('SELECT request_hash,payload FROM mixed_take_previews WHERE operation_id=$1',[operationId])).rows[0];return row?{requestHash:row.request_hash,preview:row.payload}:null;}),
  save:(operationId,requestHash,preview)=>database.use(db=>db.transaction(async tx=>{
   await tx.query(`INSERT INTO mixed_take_previews(operation_id,request_hash,id,take_id,version_id,route_revision,payload,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(operation_id) DO NOTHING`,[operationId,requestHash,preview.id,preview.takeId,preview.versionId,preview.routeRevision,JSON.stringify(preview),preview.expiresAt]);
   const row=(await tx.query<{request_hash:string;payload:MixedPreview}>('SELECT request_hash,payload FROM mixed_take_previews WHERE operation_id=$1',[operationId])).rows[0];
   if(row.request_hash!==requestHash)throw Error('Operation ID already used for another preview.');
   return row.payload;
  })),
 };
}
