import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { createDatabaseLifecycle } from './database';
import type { RunBudget } from './run-budget';
import { runLimits } from './run-budget';
import type { PlatformAccessRequest } from '../shared/mcp-management';
import { createAiAudit, recordAiAudit } from './ai-audit';
const builtin = '00000000-0000-4000-8000-000000000001';
type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
export function createPlatformAccess(db: Database, active: (id:string)=>boolean, options: {
 accounts: (run?:string)=>Promise<string[]>; budget?: (id:string)=>RunBudget|undefined; pollMs?:number; approvalMs?:number;
}) {
 const captures=createAiAudit(db);
 const inFlight = new Map<string,Promise<void>>();
 async function settings() {
  return (await db.use(d=>d.query<{verify:boolean;revision:number}>('SELECT verify,revision FROM platform_access_settings'))).rows[0];
 }
 async function context(run:string) {
  const row=(await db.use(d=>d.query<{take_id:string;configuration:{selection:{provider:string};tools?:{server:string}[];coinbaseAccount?:unknown;coinbaseAccounts?:unknown[]}}>('SELECT take_id,configuration FROM take_runs WHERE id=$1',[run]))).rows[0];
  if(!row)throw new Error('Platform data run unavailable.');
  const historical=(await db.use(d=>d.query<{accounts:string[]}>('SELECT accounts FROM take_platform_context WHERE take_id=$1',[row.take_id]))).rows[0]?.accounts??[];
  const current=row.configuration.coinbaseAccounts?.length||row.configuration.coinbaseAccount||row.configuration.tools?.some(t=>t.server===builtin)?await options.accounts(run):[];
  const accounts=[...new Set([...historical,...current])].sort();
  // Include the current selection separately so changing A -> B -> A invalidates B's grant.
  const scope=createHash('sha256').update(JSON.stringify({accounts,current:[...current].sort()})).digest('hex');
  return {take:row.take_id,provider:row.configuration.selection.provider,accounts,scope};
 }
 async function ensure(run:string) {
  z.string().uuid().parse(run);
  if(!active(run))throw new Error('Response stopped.');
  const ctx=await context(run);if(!ctx.accounts.length)return;
  const setting=await settings();
  const record=async(verified:boolean)=>{
   if(!active(run))throw new Error('Response stopped.');
   const latest=await settings();const current=await context(run);
   if(latest.revision!==setting.revision||current.scope!==ctx.scope)throw new Error('Platform access changed. Please retry your message.');
   await db.use(d=>d.transaction(async tx=>{
    await tx.query('INSERT INTO take_platform_context(take_id,accounts) VALUES($1,$2) ON CONFLICT(take_id) DO UPDATE SET accounts=(SELECT jsonb_agg(DISTINCT m) FROM jsonb_array_elements(take_platform_context.accounts || excluded.accounts) m)',[ctx.take,JSON.stringify(ctx.accounts)]);
    await tx.query("UPDATE take_runs SET configuration=jsonb_set(configuration,'{platformAccess}',$2::jsonb) WHERE id=$1",[run,JSON.stringify({verify:setting.verify,revision:setting.revision,provider:ctx.provider,scope:ctx.scope,verified})]);
   }));
   await captures.record(run,{kind:'platform.authorized',payload:{verify:setting.verify,revision:setting.revision,provider:ctx.provider,scope:ctx.scope,verified}});
  };
  if(!setting.verify){await record(false);return;}
  const grant=await db.use(d=>d.query('SELECT 1 FROM platform_access_grants WHERE take_id=$1 AND provider=$2 AND scope=$3 AND revision=$4',[ctx.take,ctx.provider,ctx.scope,setting.revision]));
  if(grant.rows.length){await record(true);return;}
  // An automatic rule run has no one to ask: fail now instead of waiting.
  if((await db.use(d=>d.query<{unattended:boolean}>("SELECT coalesce((configuration->>'unattended')::boolean,false) AS unattended FROM take_runs WHERE id=$1",[run]))).rows[0]?.unattended)throw new Error('Platform data verification is required, and automatic runs cannot ask for it. Verify this Take in chat first.');
  const budget=options.budget?.(run);const resume=budget?.pause();const id=randomUUID();
  try {
   const expires=new Date(Date.now()+Math.min(options.approvalMs??runLimits.approvalMs,budget?.remainingMs()??runLimits.approvalMs));
   await db.use(d=>d.query("INSERT INTO platform_access_requests(id,run_id,take_id,provider,scope,revision,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,'pending',$7)",[id,run,ctx.take,ctx.provider,ctx.scope,setting.revision,expires.toISOString()]));
   await captures.record(run,{kind:'platform.approval_requested',spanId:id,payload:{scope:ctx.scope,revision:setting.revision,expiresAt:expires.toISOString()}});
   while(active(run)&&Date.now()<expires.getTime()) {
    if((await settings()).revision!==setting.revision||(await context(run)).scope!==ctx.scope)throw new Error('Platform access changed. Please retry your message.');
    const row=(await db.use(d=>d.query<{state:string}>('SELECT state FROM platform_access_requests WHERE id=$1',[id]))).rows[0];
    if(row?.state==='approved') {
     const consumed=await db.use(d=>d.query("UPDATE platform_access_requests SET state='consumed' WHERE id=$1 AND state='approved' AND expires_at>now() RETURNING id",[id]));
     if(!consumed.rows.length)break;
     await record(true);
     await db.use(d=>d.query('INSERT INTO platform_access_grants(take_id,provider,scope,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[ctx.take,ctx.provider,ctx.scope,setting.revision]));
     return;
    }
    if(row?.state!=='pending')break;
    await new Promise(r=>setTimeout(r,options.pollMs??250));
   }
   throw new Error('Platform data verification declined, expired, or response stopped.');
  } finally {
   resume?.();await db.use(d=>d.query("UPDATE platform_access_requests SET state='expired' WHERE id=$1 AND state IN ('pending','approved')",[id]));
   const decision=(await db.use(d=>d.query<{state:string}>('SELECT state FROM platform_access_requests WHERE id=$1',[id]))).rows[0];
   await captures.record(run,{kind:'platform.approval_finished',spanId:id,payload:{state:decision?.state??'unavailable'}});
  }
 }
 return {
  settings,
  async configure(value:unknown) {
   const verify=z.boolean().parse(value);
   await db.use(d=>d.transaction(async tx=>{
    await tx.query('UPDATE platform_access_settings SET verify=$1,revision=revision+1 WHERE verify<>$1',[verify]);
    await tx.query('DELETE FROM platform_access_grants');
    await tx.query("UPDATE platform_access_requests SET state='expired' WHERE state IN ('pending','approved')");
   }));return settings();
  },
  ensure(run:string) {
   const pending=inFlight.get(run);if(pending)return pending;
   const work=ensure(run).finally(()=>{inFlight.delete(run);});inFlight.set(run,work);return work;
  },
  async start(){await db.use(d=>d.query("UPDATE platform_access_requests SET state='expired' WHERE state IN ('pending','approved')"));},
  async pending() {
   await db.use(d=>d.query("UPDATE platform_access_requests SET state='expired' WHERE expires_at<=now() AND state IN ('pending','approved')"));
   const rows=(await db.use(d=>d.query<PlatformAccessRequest>("SELECT id,run_id,provider,expires_at FROM platform_access_requests WHERE state='pending' ORDER BY created_at"))).rows;
   return rows.filter(row=>active(row.run_id));
  },
  async decide(id:unknown,value:unknown) {
   const key=z.string().uuid().parse(id);const approved=z.boolean().parse(value);
   const row=(await db.use(d=>d.query<{run_id:string;scope:string;revision:number}>('SELECT run_id,scope,revision FROM platform_access_requests WHERE id=$1',[key]))).rows[0];
   if(!row||!active(row.run_id)||(await settings()).revision!==row.revision||(await context(row.run_id)).scope!==row.scope)throw new Error('Platform verification is no longer active.');
   const result=await db.use(d=>d.transaction(async tx=>{const result=await tx.query("UPDATE platform_access_requests SET state=$2,decided_at=now() WHERE id=$1 AND state='pending' AND expires_at>now() RETURNING id",[key,approved?'approved':'declined']);if(result.rows.length)await recordAiAudit(tx,row.run_id,{kind:'platform.user_decision',spanId:key,payload:{decision:approved?'approved':'declined',scope:row.scope,revision:row.revision}});return result;}));
   if(!result.rows.length)throw new Error('Platform verification expired or was already decided.');
  },
 };
}
