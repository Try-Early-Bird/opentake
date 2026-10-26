import type { DatabaseClient as PGlite } from './database-client';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { createDatabaseLifecycle } from './database';
import type { ManagedServer, ToolInvocation, TakeToolPermission, ToolPolicy } from '../shared/mcp-management';
import { createAiAudit } from './ai-audit';
const builtin='00000000-0000-4000-8000-000000000001';
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
export function restrictPolicies(...values:(ToolPolicy|undefined)[]):ToolPolicy {
 return values.includes('blocked')?'blocked':values.includes('ask')?'ask':'allowed';
}
export function toolDestination(server?:ManagedServer) {
 if(!server)return 'Unavailable';
 if(server.id===builtin)return 'Built-in platform connection';
 return server.config.transport==='http'?new URL(server.config.url).origin:'Local MCP process';
}
export function createToolGovernance(db:Database) {
 const captures=createAiAudit(db);
 const uuid=z.string().uuid();const policy=z.enum(['blocked','ask','allowed']);
 async function permissions(take:unknown):Promise<TakeToolPermission[]> {
  return (await db.use(d=>d.query<TakeToolPermission>('SELECT server_id,tool_name,policy FROM take_tool_permissions WHERE take_id=$1',[uuid.parse(take)]))).rows;
 }
 async function tighten(tx:Pick<PGlite,'query'>,server:string,tool:string,value:ToolPolicy,take?:string) {
  if(value==='allowed')return;
  const rows=(await tx.query<{id:string;configuration:{tools?:{server:string;name:string;policy:ToolPolicy}[];platformToolsExposed?:boolean;initialTools?:unknown[]}}>("SELECT id,configuration FROM take_runs WHERE state IN ('starting','running','stopping') AND ($1::uuid IS NULL OR take_id=$1)",[take??null])).rows;
  for(const row of rows){
   const tools=(row.configuration.tools??[]).flatMap(t=>t.server!==server||(tool&&t.name!==tool)?[t]:value==='blocked'?[]:[{...t,policy:restrictPolicies(t.policy,value)}]);
   await tx.query('UPDATE take_runs SET configuration=$2 WHERE id=$1',[row.id,JSON.stringify({...row.configuration,initialTools:row.configuration.initialTools??row.configuration.tools??[],tools,platformToolsExposed:row.configuration.platformToolsExposed||row.configuration.tools?.some(t=>t.server===builtin)||false})]);
  }
 }
 return {
  permissions,
  async setPermission(take:unknown,server:unknown,tool:unknown,value:unknown) {
   const args=[uuid.parse(take),uuid.parse(server),z.string().max(200).parse(tool)];
   if(value===null){await db.use(d=>d.query('DELETE FROM take_tool_permissions WHERE take_id=$1 AND server_id=$2 AND tool_name=$3',args));return;}
   const selected=policy.parse(value);
   if(args[2]){const exists=await db.use(d=>d.query('SELECT 1 FROM mcp_tools WHERE server_id=$1 AND name=$2',[args[1],args[2]]));if(!exists.rows.length)throw new Error('Tool unavailable.');}
   await db.use(d=>d.transaction(async tx=>{await tx.query('INSERT INTO take_tool_permissions(take_id,server_id,tool_name,policy) VALUES($1,$2,$3,$4) ON CONFLICT(take_id,server_id,tool_name) DO UPDATE SET policy=excluded.policy',[...args,selected]);await tighten(tx,args[1],args[2],selected,args[0]);}));
  },
  /** Changed tools from a trusted server keep their setting (the member's own MCP, say). */
  async trustUpdates(id:unknown,value:unknown){const key=uuid.parse(id);const trusted=z.boolean().parse(value);await db.use(d=>d.query('UPDATE mcp_servers SET trust_updates=$2 WHERE id=$1',[key,trusted]));},
  async serverPolicy(id:unknown,value:unknown){const key=uuid.parse(id);const selected=policy.parse(value);await db.use(d=>d.transaction(async tx=>{await tx.query('UPDATE mcp_servers SET policy=$2 WHERE id=$1',[key,selected]);await tighten(tx,key,'',selected);}));},
  async toolPolicy(id:unknown,name:unknown,value:unknown){const key=uuid.parse(id);const tool=z.string().max(200).parse(name);const selected=policy.parse(value);await db.use(d=>d.transaction(async tx=>{// Blocking records that the member chose it; opening a tool is its review, so the change is settled.
   await tx.query("UPDATE mcp_tools SET policy=$1,blocked_reason=CASE WHEN $1='blocked' THEN 'member' END,previous_definition=CASE WHEN $1='blocked' THEN previous_definition END,changed_at=CASE WHEN $1='blocked' THEN changed_at END WHERE server_id=$2 AND name=$3",[selected,key,tool]);await tighten(tx,key,tool,selected);}));},
  async platformSharing(run:string) {
   const r=(await db.use(d=>d.query<{configuration:{tools?:{server:string}[];platformToolsExposed?:boolean};accounts:unknown[]|null}>(`SELECT r.configuration,p.accounts FROM take_runs r LEFT JOIN take_platform_context p ON p.take_id=r.take_id WHERE r.id=$1`,[run]))).rows[0];
   return !!r&&(!!r.accounts?.length||r.configuration.platformToolsExposed||!!r.configuration.tools?.some(t=>t.server===builtin));
  },
  async begin(run:string,name:string,server?:ManagedServer) {
   const id=randomUUID();
   const inserted=await db.use(d=>d.query(`INSERT INTO tool_invocations(id,run_id,take_id,provider,server_id,server_name,tool_name,destination,state,metadata_revision)
    SELECT $1,id,take_id,coalesce(configuration->'selection'->>'provider','unknown'),$3::uuid,$4,$5,$6,'checking',(SELECT (t->>'metadataRevision')::bigint FROM jsonb_array_elements(coalesce(configuration->'tools','[]'::jsonb)) t WHERE t->>'server'=$3::uuid::text AND t->>'name'=$5 LIMIT 1) FROM take_runs WHERE id=$2 RETURNING id,metadata_revision::text`,[id,uuid.parse(run),server?.id??null,server?.config.name??'Unavailable',name.slice(0,200),toolDestination(server)]));
   if(!inserted.rows.length)throw new Error('Run unavailable.');
   await captures.record(run,{kind:'tool.checking',spanId:id,payload:{tool:name,serverId:server?.id,serverName:server?.config.name,destination:toolDestination(server),metadataRevision:(inserted.rows[0] as {metadata_revision?:string}).metadata_revision}});
   return {
    id,
    async approval(sharing:boolean){await db.use(d=>d.query(`UPDATE tool_invocations SET state='awaiting_approval',"approval_mode"='pending',platform_sharing=$2 WHERE id=$1`,[id,sharing]));await captures.record(run,{kind:'approval.requested',spanId:id,payload:{platformSharing:sharing}});},
    async decision(value:string){await db.use(d=>d.query('UPDATE tool_invocations SET "approval_mode"=$2 WHERE id=$1',[id,value]));await captures.record(run,{kind:'approval.decided',spanId:id,payload:{decision:value}});},
    async dispatch(){await db.use(d=>d.query("UPDATE tool_invocations SET state='running',dispatched_at=now() WHERE id=$1",[id]));await captures.record(run,{kind:'tool.dispatch_intent',spanId:id,payload:{}});},
    async finish(state:string,detail:string,dispatched:boolean){await db.use(d=>d.query(`UPDATE tool_invocations SET state=$2,detail=$3,finished_at=now(),dispatched_at=CASE WHEN $4 THEN dispatched_at ELSE NULL END,"approval_mode"=CASE WHEN "approval_mode"='pending' THEN $2 ELSE "approval_mode" END WHERE id=$1 AND finished_at IS NULL`,[id,state,detail,dispatched]));await captures.record(run,{kind:'tool.finished',spanId:id,payload:{state,detail,dispatched,outcomeKnown:state==='succeeded'||!dispatched}});},
   };
  },
  async history(input:unknown) {
   const filter=z.object({takeId:uuid.nullable().optional(),before:z.string().regex(/^\d+$/).max(20).optional()}).strict().parse(input??{});
   const rows=(await db.use(d=>d.query<ToolInvocation>(`SELECT i.id,i.metadata_revision::text,i.sequence::text,i.run_id,i.take_id,t.title AS take_title,i.provider,i.server_name,i.tool_name,i.destination,i.state,i."approval_mode",i.platform_sharing,i.started_at,i.dispatched_at,i.finished_at,i.detail,
    EXTRACT(EPOCH FROM (coalesce(i.finished_at,now())-i.started_at))*1000 AS duration_ms
    FROM tool_invocations i JOIN takes t ON t.id=i.take_id
    WHERE ($1::uuid IS NULL OR i.take_id=$1) AND ($2::bigint IS NULL OR i.sequence<$2)
    ORDER BY i.sequence DESC LIMIT 51`,[filter.takeId??null,filter.before??null]))).rows;
   return {items:rows.slice(0,50),next:rows.length>50?rows[49].sequence:null};
  },
  async recover(){await db.use(d=>d.query("UPDATE tool_invocations SET state='interrupted',finished_at=now(),approval_mode=CASE WHEN approval_mode='pending' THEN 'expired' ELSE approval_mode END,detail='App stopped before completion; outcome may be unknown.' WHERE finished_at IS NULL"));},
 };
}
