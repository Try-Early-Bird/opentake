import {randomUUID} from 'node:crypto';
import type {createDatabaseLifecycle} from '../database';
import type {AccountQueues} from './account-queues';
import type {Capability} from './capabilities';
import type {AdmissionCheck} from './admission';
import type {VenueRegistry} from '../venues/registry';
import type {ActionJob,ActionKind,ActionOrigin,ActionOutcome,ActionState,WaitingFor} from '../venues/types';

// The shared lifecycle for every action. A job is created once per
// origin (idempotency key), then advanced one adapter step at a time inside its
// account's queue until it reaches a terminal state. Adapters own their phases
// and must never resend an order whose result is unknown; the core owns the
// schedule, retries, deadlines, cancellation and history (action_job_events).

type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
export interface EnqueueAction{
 kind:ActionKind;origin:ActionOrigin;originId:string;idempotencyKey:string;
 takeId?:string|null;accountId?:string|null;venue?:string|null;input?:unknown;
 /** An unsupported action is recorded as blocked with its reason instead of silently dropped. */
 capability?:Capability;
}
interface Row{id:string;kind:ActionKind;origin:ActionOrigin;origin_id:string;take_id:string|null;account_id:string|null;venue:string|null;input:unknown;state:ActionState;waiting_for:WaitingFor|null;reason:string|null;attempts:number;adapter_state:Record<string,unknown>;created_at:Date;updated_at:Date;started_at:Date|null}
const terminal:readonly ActionState[]=['succeeded','blocked','failed','needs_attention','cancelled'];
const STEP_DEADLINE_MS=120_000,WAIT_RETRY_MS=60_000,MAX_ERRORS=5,BATCH=16;
const job=(r:Row):ActionJob=>({id:r.id,kind:r.kind,origin:r.origin,originId:r.origin_id,takeId:r.take_id,accountId:r.account_id,venue:r.venue,input:r.input,state:r.state,waitingFor:r.waiting_for,reason:r.reason,attempts:r.attempts,adapterState:r.adapter_state,createdAt:r.created_at,updatedAt:r.updated_at,startedAt:r.started_at});

export function createActionJobs(database:Database,registry:VenueRegistry,options:{accounts?:AccountQueues;clock?:()=>number;wake?:()=>void;report?:(error:unknown,job:ActionJob)=>void;stepDeadlineMs?:number;admit?:AdmissionCheck}={}){
 const clock=options.clock??Date.now,recovered=new Set<string>();
 const iso=(ms=clock())=>new Date(ms).toISOString();
 const load=async(id:string)=>{const r=(await database.use(db=>db.query<Row>('SELECT * FROM action_jobs WHERE id=$1',[id]))).rows[0];return r?job(r):null;};
 async function write(id:string,outcome:ActionOutcome){
  const waiting=outcome.state==='waiting'?outcome.waitingFor:null;
  const reason='reason' in outcome?outcome.reason??null:null;
  const delay=outcome.state==='running'?outcome.retryInMs??0:outcome.state==='waiting'?outcome.retryInMs??WAIT_RETRY_MS:0;
  // A terminal row never moves again, even if a late step reports otherwise.
  await database.use(db=>db.query(`UPDATE action_jobs SET state=$2,waiting_for=$3,reason=$4,next_run_at=$5,updated_at=$6,
   adapter_state=CASE WHEN $7::jsonb IS NULL THEN adapter_state ELSE $7::jsonb END
   WHERE id=$1 AND state NOT IN ('succeeded','blocked','failed','needs_attention','cancelled')`,
   [id,outcome.state,waiting,reason,iso(clock()+delay),iso(),outcome.adapterState===undefined?null:JSON.stringify(outcome.adapterState)]));
 }
 /** Committed before any adapter call, so a crash right after still shows the adapter may have run. */
 async function markStarted(current:ActionJob){
  if(current.startedAt)return;
  await database.use(db=>db.query('UPDATE action_jobs SET started_at=$2 WHERE id=$1 AND started_at IS NULL',[current.id,iso()]));
 }
 async function step(current:ActionJob,signal:AbortSignal){
  const adapter=current.venue?registry.adapter(current.venue,current.kind):registry.local(current.kind);
  if(!adapter){await write(current.id,{state:'blocked',reason:'action_unsupported'});return;}
  // A refused job that never reached its adapter has reserved and sent nothing, so
  // blocking it here is safe. Once the adapter has run, only the adapter ends the job.
  if(options.admit&&!current.startedAt&&current.venue&&registry.module(current.venue)?.admission==='core'){
   const admission=await options.admit(current,false);
   if(!admission.admitted){await write(current.id,{state:'blocked',reason:admission.reason});return;}
  }
  await markStarted(current);
  const stepSignal=AbortSignal.any([signal,AbortSignal.timeout(options.stepDeadlineMs??STEP_DEADLINE_MS)]);
  const context={signal:stepSignal,now:clock};
  try{
   const parsed={...current,input:adapter.parse(current.input)};
   if(!recovered.has(current.id)){await adapter.recover?.(parsed,context);recovered.add(current.id);}
   await write(current.id,await adapter.advance(parsed,context));
  }catch(error){
   // Shutting down is not a failure of the action; it resumes next launch.
   if(signal.aborted)return;
   options.report?.(error,current);
   // An adapter error is retried with backoff; repeated errors ask the member instead of guessing.
   await database.use(db=>db.query(`UPDATE action_jobs SET attempts=attempts+1,updated_at=$3,
    next_run_at=$3::timestamptz+make_interval(secs=>least(3600,power(2,attempts+1))),
    state=CASE WHEN attempts+1>=$2 THEN 'needs_attention' ELSE state END,
    waiting_for=CASE WHEN attempts+1>=$2 THEN NULL ELSE waiting_for END,
    reason=CASE WHEN attempts+1>=$2 THEN 'adapter_error' ELSE reason END
    WHERE id=$1 AND state NOT IN ('succeeded','blocked','failed','needs_attention','cancelled')`,[current.id,MAX_ERRORS,iso()]));
  }
 }
 const inQueue=<T>(current:ActionJob,work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal)=>
  options.accounts&&current.accountId?options.accounts.run([current.accountId],work,{label:'action job',signal}):work(signal??new AbortController().signal);

 return {
  /** Create the job for an origin once; a repeat returns the existing job. */
  async enqueue(input:EnqueueAction):Promise<ActionJob>{
   if(input.venue&&!registry.has(input.venue))throw new Error(`Unknown venue ${input.venue}`);
   const blocked=input.capability&&!input.capability.supported?input.capability.reason:null;
   const row=(await database.use(db=>db.query<Row>(`INSERT INTO action_jobs(id,kind,origin,origin_id,take_id,account_id,venue,idempotency_key,input,state,reason,created_at,updated_at,next_run_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$12) ON CONFLICT(idempotency_key) DO NOTHING RETURNING *`,
    [randomUUID(),input.kind,input.origin,input.originId,input.takeId??null,input.accountId??null,input.venue??null,input.idempotencyKey,JSON.stringify(input.input??{}),blocked?'blocked':'queued',blocked,iso()]))).rows[0];
   if(row){if(!blocked)options.wake?.();return job(row);}
   const existing=(await database.use(db=>db.query<Row>('SELECT * FROM action_jobs WHERE idempotency_key=$1',[input.idempotencyKey]))).rows[0]!;
   if(existing.kind!==input.kind||existing.origin_id!==input.originId)throw new Error('Idempotency key already used for another action.');
   return job(existing);
  },
  get:load,
  forTake:async(takeId:string)=>(await database.use(db=>db.query<Row>('SELECT * FROM action_jobs WHERE take_id=$1 ORDER BY created_at DESC LIMIT 50',[takeId]))).rows.map(job),
  /** Advance every due job one step. Jobs on different accounts do not wait on each other's turn. */
  async tick(signal?:AbortSignal){
   const due=(await database.use(db=>db.query<Row>(`SELECT * FROM action_jobs WHERE state IN ('queued','running','waiting') AND next_run_at<=$1 ORDER BY next_run_at,id LIMIT ${BATCH}`,[iso()]))).rows.map(job);
   await Promise.all(due.map(async current=>{
    if(signal?.aborted)return;
    await inQueue(current,async s=>{
     // Re-read inside the account turn: a member may have cancelled it meanwhile.
     const fresh=await load(current.id);if(!fresh||terminal.includes(fresh.state))return;
     await step(fresh,s);
    },signal).catch(error=>options.report?.(error,current));
   }));
  },
  /** Member cancellation: the adapter releases what was reserved; filled orders stay. */
  async cancel(id:string):Promise<ActionJob|null>{
   const current=await load(id);if(!current||terminal.includes(current.state))return current;
   await inQueue(current,async signal=>{
    const fresh=await load(id);if(!fresh||terminal.includes(fresh.state))return;
    const adapter=fresh.venue?registry.adapter(fresh.venue,fresh.kind):registry.local(fresh.kind);
    if(!adapter?.cancel){
     await database.use(db=>db.query(`UPDATE action_jobs SET state='cancelled',waiting_for=NULL,reason='member_cancelled',updated_at=$2
      WHERE id=$1 AND state NOT IN ('succeeded','blocked','failed','needs_attention','cancelled')`,[id,iso()]));
     return;
    }
    // An adapter that answers running or waiting could not cancel now (e.g. orders already
    // out); the job keeps going and is advanced as usual.
    await markStarted(fresh);
    await write(id,await adapter.cancel({...fresh,input:adapter.parse(fresh.input)},{signal,now:clock}));
   });
   return load(id);
  },
  /** Make an account's waiting or running jobs due now, e.g. after orders were sent there. */
  async nudge(accountId?:string){
   await database.use(db=>db.query(`UPDATE action_jobs SET next_run_at=$1 WHERE state IN ('running','waiting') AND next_run_at>$1 AND ($2::uuid IS NULL OR account_id=$2)`,[iso(),accountId??null]));
   options.wake?.();
  },
  history:async(id:string)=>(await database.use(db=>db.query<{state:ActionState;waiting_for:WaitingFor|null;reason:string|null;attempts:number;occurred_at:Date}>('SELECT state,waiting_for,reason,attempts,occurred_at FROM action_job_events WHERE job_id=$1 ORDER BY id',[id]))).rows,
 };
}
export type ActionJobs=ReturnType<typeof createActionJobs>;
