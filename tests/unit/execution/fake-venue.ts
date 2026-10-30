// A synthetic venue for the shared action core: a broker that can answer, refuse,
// lose a response or hang, and a reservation ledger that survives "restarts".
import {z} from 'zod';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {createActionJobs} from '../../../src/main/execution/action-jobs';
import {createAccountQueues} from '../../../src/main/execution/account-queues';
import {createVenueRegistry,coinbaseProfile} from '../../../src/main/venues/registry';
import type {ActionAdapter,VenueModule,VenueProfile} from '../../../src/main/venues/types';
import type {AdmissionHarness,ConformanceHarness,SubmitMode} from './action-conformance';
import type {Admission} from '../../../src/main/execution/admission';

type Order={clientRef:string;amount:number;filled:number;open:boolean};
export function fakeBroker(){
 const orders=new Map<string,Order>();let mode:SubmitMode='accept',received=0;
 return {
  orders,
  sent:()=>received,
  nextSubmit:(next:SubmitMode)=>{mode=next;},
  async submit(clientRef:string,amount:number,signal:AbortSignal):Promise<'accepted'|'rejected'>{
   const current=mode;mode='accept';
   if(current==='reject')return 'rejected';
   received++;orders.set(clientRef,{clientRef,amount,filled:0,open:true});
   if(current==='lost')throw new Error('response lost');
   if(current==='hang')await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
   // The process dies here: nothing after this point ever runs.
   if(current==='crash')await new Promise(()=>{});
   return 'accepted';
  },
  find:(clientRef:string)=>orders.get(clientRef)??null,
  cancel(clientRef:string){const o=orders.get(clientRef);if(o)o.open=false;},
  fill(amount:'all'|'part'){for(const o of orders.values())if(o.open){o.filled=amount==='all'?o.amount:o.amount/2;if(amount==='all')o.open=false;}},
 };
}
export type FakeBroker=ReturnType<typeof fakeBroker>;

/** Durable outside the job row, as a venue's own reservation and dispatch tables are. */
export function fakeLedger(){
 const reserved=new Map<string,number>(),sending=new Set<string>();
 return {reserved,sending,
  /** The process dies right after the next reservation is written, before any outcome is returned. */
  crashAfterReserve:false,
  reserve:(id:string,amount:number)=>{if(!reserved.has(id))reserved.set(id,amount);},
  release:(id:string,keep=0)=>{reserved.set(id,0);return keep;},
 };
}
export type FakeLedger=ReturnType<typeof fakeLedger>;

const input=z.object({amount:z.number().positive()}).strict();
type State={phase?:'reserved'|'sent'};
export function fakeBuyAdapter(broker:FakeBroker,ledger:FakeLedger):ActionAdapter<z.infer<typeof input>,State>{
 return {
  kind:'buy',parse:raw=>input.parse(raw),
  async recover(job){
   // A dispatch recorded as sending with no answer: look the order up, never resend.
   if(ledger.sending.has(job.id)&&job.adapterState.phase!=='sent'&&broker.find(job.id))job.adapterState.phase='sent';
  },
  async advance(job,{signal}){
   const phase=job.adapterState.phase;
   if(!phase){
    ledger.reserve(job.id,job.input.amount);
    if(ledger.crashAfterReserve){ledger.crashAfterReserve=false;await new Promise(()=>{});}
    return {state:'running',adapterState:{phase:'reserved'}};
   }
   if(phase==='reserved'){
    if(ledger.sending.has(job.id))return broker.find(job.id)?{state:'running',adapterState:{phase:'sent'}}:{state:'needs_attention',reason:'order_uncertain'};
    ledger.sending.add(job.id);
    let answer:'accepted'|'rejected';
    try{answer=await broker.submit(job.id,job.input.amount,signal);}
    catch{return {state:'needs_attention',reason:'order_uncertain'};}
    if(answer==='rejected'){ledger.sending.delete(job.id);ledger.release(job.id);return {state:'blocked',reason:'order_rejected'};}
    return {state:'running',adapterState:{phase:'sent'},retryInMs:0};
   }
   const order=broker.find(job.id);
   if(!order)return {state:'needs_attention',reason:'order_missing'};
   if(order.open)return {state:'running',retryInMs:0};
   ledger.release(job.id);return {state:'succeeded',reason:'filled'};
  },
  async cancel(job){
   const order=broker.find(job.id);
   if(order?.open)broker.cancel(job.id);
   ledger.release(job.id);
   return {state:'cancelled',reason:order&&order.filled>0?'partially_filled':'member_cancelled'};
  },
 };
}
export const fakeProfile:VenueProfile={...coinbaseProfile,id:'fake',label:'Fake'};

export async function fakeHarness(options:{stepDeadlineMs?:number}={}):Promise<ConformanceHarness&AdmissionHarness&{db:PGlite;account:string;broker:FakeBroker;ledger:FakeLedger}>{
 const db=new PGlite();await migrate(db);
 // Adding a venue is one row; this is what an appended migration would insert.
 await db.query("INSERT INTO venues(id) VALUES('fake')");
 const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','synthetic' FROM local_owners RETURNING id")).rows[0].id;
 const account=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,'fake','F') RETURNING id",[connection])).rows[0].id;
 const database={use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)};
 const broker=fakeBroker(),ledger=fakeLedger();
 // The fake venue opts in to the core's admission; its permission is a switch the tests flip.
 let admission:Admission={admitted:true};
 const build=()=>{
  const module:VenueModule={profile:fakeProfile,admission:'core',adapters:{buy:fakeBuyAdapter(broker,ledger)}};
  return createActionJobs(database as never,createVenueRegistry([module]),{accounts:createAccountQueues(),stepDeadlineMs:options.stepDeadlineMs??200,admit:async()=>admission});
 };
 const harness={db,account,broker,ledger,jobs:build(),
  enqueue:(key?:string)=>harness.jobs.enqueue({kind:'buy',origin:'rule',originId:crypto.randomUUID(),idempotencyKey:key??crypto.randomUUID(),accountId:account,venue:'fake',input:{amount:10}}),
  reserved:async(job:{id:string})=>ledger.reserved.get(job.id)??0,
  restart:async()=>{harness.jobs=build();return harness.jobs;},
  revoke:()=>{admission={admitted:false,reason:'trading_not_granted'};},
  restore:()=>{admission={admitted:true};},
  crashAfterReserve:()=>{ledger.crashAfterReserve=true;},
  close:()=>db.close(),
 };
 // Repeated enqueues of one key share one origin.
 const origins=new Map<string,string>();
 harness.enqueue=(key?:string)=>{const k=key??crypto.randomUUID();if(!origins.has(k))origins.set(k,crypto.randomUUID());return harness.jobs.enqueue({kind:'buy',origin:'rule',originId:origins.get(k)!,idempotencyKey:k,accountId:account,venue:'fake',input:{amount:10}});};
 return harness;
}
