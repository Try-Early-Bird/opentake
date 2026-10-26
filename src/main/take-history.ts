import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import type {createDatabaseLifecycle} from './database';
import type {TakeMessage,TakeSummary} from '../shared/takes';
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
const uuid=z.string().uuid();const pageSize=30;
export function createTakeHistory(db:Database){
 const key=randomBytes(32);
 const encode=(value:unknown)=>{const body=Buffer.from(JSON.stringify(value)).toString('base64url');return body+'.'+createHmac('sha256',key).update(body).digest('hex');};
 function decode(value:unknown):Record<string,unknown>{
  if(typeof value!=='string'||value.length>1500)throw new Error('History cursor expired. Refresh this take.');
  const [body,tag]=value.split('.');const expected=createHmac('sha256',key).update(body).digest('hex');
  if(!tag||tag.length!==expected.length||!timingSafeEqual(Buffer.from(tag),Buffer.from(expected)))throw new Error('History cursor expired. Refresh this take.');
  return JSON.parse(Buffer.from(body,'base64url').toString());
 }
 async function decorate(takeId:string,messages:TakeMessage[]){
  if(!messages.length)return messages;
  // Rank siblings once per Take, before filtering to the displayed page.
  const rows=await db.use(d=>d.query<{id:string;number:string;count:string}>(`WITH ranked AS (SELECT id,CASE WHEN data->>'role' IS NULL THEN '0' ELSE row_number() OVER (PARTITION BY parent_id,data->>'role' ORDER BY sequence)::text END AS number,CASE WHEN data->>'role' IS NULL THEN '0' ELSE count(*) OVER (PARTITION BY parent_id,data->>'role')::text END AS count FROM take_messages WHERE take_id=$1) SELECT id,number,count FROM ranked WHERE id=ANY($2::uuid[])`,[takeId,messages.map(m=>m.id)]));
  return messages.map(({replay,...m})=>{const v=rows.rows.find(r=>r.id===m.id);return {...m,versionNumber:Number(v?.number??1),versionCount:Number(v?.count??1)};});
 }
 return {decorate,
  async messages(takeId:unknown,headId:string|null,cursor?:unknown){
   uuid.parse(takeId);if(headId)uuid.parse(headId);let start=headId;
   if(cursor!==undefined){const c=decode(cursor);if(c.kind!=='messages'||c.take!==takeId||c.head!==headId)throw new Error('This branch changed. Refresh before loading more messages.');start=uuid.parse(c.next);}
   if(!start)return {messages:[],next:null};
   const r=await db.use(d=>d.query<{data:TakeMessage;depth:number}>(`WITH RECURSIVE branch AS (SELECT id,parent_id,data,0 AS depth,ARRAY[id] AS visited FROM take_messages WHERE id=$2 AND take_id=$1 UNION ALL SELECT m.id,m.parent_id,m.data,b.depth+1,b.visited||m.id FROM take_messages m JOIN branch b ON m.id=b.parent_id WHERE m.take_id=$1 AND b.depth<$3 AND NOT m.id=ANY(b.visited)) SELECT data-'replay' AS data,depth FROM branch ORDER BY depth`,[takeId,start,pageSize]));
   const selected:typeof r.rows=[];let bytes=0;for(const row of r.rows.slice(0,pageSize)){const size=Buffer.byteLength(JSON.stringify(row.data));if(selected.length&&bytes+size>512*1024)break;selected.push(row);bytes+=size;}return {messages:await decorate(takeId as string,selected.map(r=>r.data).reverse()),next:r.rows.length>selected.length?encode({kind:'messages',take:takeId,head:headId,next:r.rows[selected.length].data.id}):null};
  },
  async takes(archived:unknown,cursor?:unknown){
   let before:{date:string;id:string}|undefined;
   if(cursor!==undefined){const c=decode(cursor);if(c.kind!=='takes'||c.archived!==(archived===true))throw new Error('Take list changed. Refresh before loading more.');before={date:z.string().parse(c.date),id:uuid.parse(c.id)};}
   const r=await db.use(d=>d.query<TakeSummary>(`SELECT t.id,t.title,t.updated_at::text AS "updatedAt",t.archived_at::text AS "archivedAt",
     CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('status',CASE WHEN s.current_version_id IS NULL THEN 'draft' ELSE 'committed' END,
      'invested',EXISTS(SELECT 1 FROM strategy_allocations a WHERE a.strategy_id=s.id AND a.status IN ('active','paused','diverged')) OR EXISTS(SELECT 1 FROM coinbase_allocations ca JOIN coinbase_allocation_entries ce ON ce.allocation_id=ca.id WHERE ca.strategy_id=s.id GROUP BY ca.id,ce.asset HAVING sum(ce.quantity)>0)) END AS strategy
     FROM takes t LEFT JOIN strategies s ON s.id=t.strategy_id
     WHERE (t.archived_at IS NOT NULL)=$1 AND ($2::timestamptz IS NULL OR (t.updated_at,t.id)<($2::timestamptz,$3::uuid)) ORDER BY t.updated_at DESC,t.id DESC LIMIT $4`,[archived===true,before?.date??null,before?.id??null,pageSize+1]));
   const items=r.rows.slice(0,pageSize),last=items.at(-1);return {items,next:r.rows.length>pageSize&&last?encode({kind:'takes',archived:archived===true,date:last.updatedAt,id:last.id}):null};
  },
  async versions(takeId:unknown,messageId:unknown,cursor?:unknown){
   uuid.parse(takeId);uuid.parse(messageId);let before:string|null=null;
   if(cursor!==undefined){const c=decode(cursor);if(c.kind!=='versions'||c.take!==takeId||c.message!==messageId)throw new Error('Version cursor expired. Reopen versions.');before=z.string().regex(/^\d+$/).parse(c.before);}
   const r=await db.use(d=>d.query<{id:string;number:string}>(`WITH versions AS (SELECT v.id,row_number() OVER (ORDER BY v.sequence)::text AS number FROM take_messages v JOIN take_messages m ON v.take_id=m.take_id AND v.parent_id IS NOT DISTINCT FROM m.parent_id AND v.data->>'role'=m.data->>'role' WHERE m.take_id=$1 AND m.id=$2) SELECT * FROM versions WHERE ($3::bigint IS NULL OR number::bigint<$3::bigint) ORDER BY number::bigint DESC LIMIT $4`,[takeId,messageId,before,pageSize+1]));
   const items=r.rows.slice(0,pageSize).map(v=>({id:v.id,number:Number(v.number)}));return {items,next:r.rows.length>pageSize?encode({kind:'versions',take:takeId,message:messageId,before:String(items.at(-1)!.number)}):null};
  }
 };
}
