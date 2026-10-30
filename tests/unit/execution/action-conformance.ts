// The contract every venue action adapter must pass. It runs
// against the fake venue here and against each real adapter with its own synthetic
// broker. No live profile, credentials or network.
import {expect,test} from 'vitest';
import type {ActionJobs} from '../../../src/main/execution/action-jobs';
import type {ActionJob} from '../../../src/main/venues/types';

export type SubmitMode='accept'|'reject'|'lost'|'hang'|'crash';
export interface ConformanceHarness{
 jobs:ActionJobs;
 /** Create the venue's standard order-placing action for a funded Take. */
 enqueue(key?:string):Promise<ActionJob>;
 broker:{
  /** Orders the broker received (including ones whose response was lost). */
  sent():number;
  /** How the next submit behaves: answered, refused, sent but unanswered, never returning,
   *  or received by the broker while the app dies before recording anything. */
  nextSubmit(mode:SubmitMode):void;
  fill(amount:'all'|'part'):Promise<void>;
 };
 /** Cash still reserved for the action's job. */
 reserved(job:ActionJob):Promise<number>;
 /** A new core and adapter over the same database and broker, as after a crash. */
 restart():Promise<ActionJobs>;
 close():Promise<void>;
}
const until=async(jobs:ActionJobs,id:string,done:(job:ActionJob)=>boolean,ticks=10)=>{
 for(let i=0;i<ticks;i++){const current=(await jobs.get(id))!;if(done(current))return current;await jobs.tick();}
 return (await jobs.get(id))!;
};
const final=(job:ActionJob)=>['succeeded','blocked','failed','needs_attention','cancelled'].includes(job.state);
/** Asks the member: terminal attention, or attention that keeps being re-checked on the account. */
const asksForAttention=(job:ActionJob)=>job.state==='needs_attention'||(job.state==='waiting'&&job.waitingFor==='account');
const settled=(job:ActionJob)=>final(job)||asksForAttention(job);
/** A venue whose trade jobs the core admits (`VenueModule.admission='core'`). */
export interface AdmissionHarness extends ConformanceHarness{
 /** From now on the firing's grant reads as revoked. */
 revoke():void;
 restore():void;
 /** The process dies right after the adapter's next reservation, before any outcome is saved. */
 crashAfterReserve():void;
}
/** Cases a real adapter covers in its own suite, by test name, with the reason. */
export type CoveredElsewhere=Partial<Record<'crash'|'hang'|'partialCancel',string>>;

export function actionAdapterConformance(name:string,make:()=>Promise<ConformanceHarness>,covered:CoveredElsewhere={}){
 const caseTest=(key:keyof CoveredElsewhere,title:string,run:()=>Promise<void>)=>covered[key]?test.skip(`${title} (covered by: ${covered[key]})`,run):test(title,run);
 test(`${name}: a repeated firing and repeated steps send one order, then succeed on fill`,async()=>{
  const h=await make();try{
   const job=await h.enqueue('same');expect((await h.enqueue('same')).id).toBe(job.id);
   await until(h.jobs,job.id,()=>h.broker.sent()>0);for(let i=0;i<3;i++)await h.jobs.tick();
   expect(h.broker.sent()).toBe(1);
   await h.broker.fill('all');const done=await until(h.jobs,job.id,final);
   expect(done.state).toBe('succeeded');expect(await h.reserved(done)).toBe(0);expect(h.broker.sent()).toBe(1);
  }finally{await h.close();}
 });
 test(`${name}: an unanswered submit is never resent, keeps its reservation and asks for attention`,async()=>{
  const h=await make();try{
   h.broker.nextSubmit('lost');const job=await h.enqueue();
   const done=await until(h.jobs,job.id,settled);
   expect(asksForAttention(done)).toBe(true);expect(h.broker.sent()).toBe(1);expect(await h.reserved(done)).toBeGreaterThan(0);
   for(let i=0;i<3;i++)await h.jobs.tick();expect(h.broker.sent()).toBe(1);
  }finally{await h.close();}
 });
 caseTest('crash',`${name}: a crash after the broker received the order recovers it instead of resending`,async()=>{
  const h=await make();try{
   h.broker.nextSubmit('crash');const job=await h.enqueue();
   for(let i=0;i<5&&!h.broker.sent();i++)void h.jobs.tick();
   await new Promise(resolve=>setTimeout(resolve,50));expect(h.broker.sent()).toBe(1);
   const restarted=await h.restart();await restarted.tick();expect(h.broker.sent()).toBe(1);await h.broker.fill('all');
   const done=await until(restarted,job.id,final);
   expect(done.state).toBe('succeeded');expect(h.broker.sent()).toBe(1);
  }finally{await h.close();}
 });
 test(`${name}: a refused order releases its reservation, is never resent, and is blocked or asks for attention`,async()=>{
  const h=await make();try{
   h.broker.nextSubmit('reject');const job=await h.enqueue();
   const done=await until(h.jobs,job.id,settled);
   // Blocked, or attention when the venue cannot prove nothing filled; never resent.
   expect(done.state==='blocked'||asksForAttention(done)).toBe(true);expect(await h.reserved(done)).toBe(0);
   for(let i=0;i<3;i++)await h.jobs.tick();expect(h.broker.sent()).toBeLessThanOrEqual(1);
  }finally{await h.close();}
 });
 test(`${name}: cancelling before sending releases everything and sends nothing`,async()=>{
  const h=await make();try{
   const job=await h.enqueue();const cancelled=(await h.jobs.cancel(job.id))!;
   expect(cancelled.state).toBe('cancelled');expect(h.broker.sent()).toBe(0);expect(await h.reserved(cancelled)).toBe(0);
   await h.jobs.tick();expect(h.broker.sent()).toBe(0);
  }finally{await h.close();}
 });
 caseTest('partialCancel',`${name}: cancelling after a partial fill keeps the fill, releases the rest and never resends`,async()=>{
  const h=await make();try{
   const job=await h.enqueue();await until(h.jobs,job.id,()=>h.broker.sent()>0);await h.broker.fill('part');
   await h.jobs.cancel(job.id);
   // Cancelling sent orders may finish asynchronously on a real exchange.
   const cancelled=await until(h.jobs,job.id,settled);
   expect(['cancelled','needs_attention','blocked']).toContain(cancelled.state);expect(await h.reserved(cancelled)).toBe(0);
   for(let i=0;i<3;i++)await h.jobs.tick();expect(h.broker.sent()).toBe(1);
  }finally{await h.close();}
 });
 caseTest('hang',`${name}: a submit hung past the step deadline is aborted and never resent`,async()=>{
  const h=await make();try{
   h.broker.nextSubmit('hang');const job=await h.enqueue();
   const done=await until(h.jobs,job.id,settled);
   expect(asksForAttention(done)).toBe(true);expect(h.broker.sent()).toBeLessThanOrEqual(1);
   for(let i=0;i<3;i++)await h.jobs.tick();expect(h.broker.sent()).toBeLessThanOrEqual(1);
  }finally{await h.close();}
 });
}

/** What the core guarantees for a venue it admits: a refusal is terminal only for a job the
 *  adapter never saw; anything the adapter touched is the adapter's to end. The dispatch
 *  gate (refusing a *new send* after a revocation) is a separate contract. */
export function admissionConformance(name:string,make:()=>Promise<AdmissionHarness>){
 test(`${name}: a job refused before its first step is blocked with the reason; nothing reserved, nothing sent, adapter never called`,async()=>{
  const h=await make();try{
   h.revoke();const job=await h.enqueue();await h.jobs.tick();
   const done=(await h.jobs.get(job.id))!;
   expect(done).toMatchObject({state:'blocked',reason:'trading_not_granted',startedAt:null});
   expect(await h.reserved(done)).toBe(0);expect(h.broker.sent()).toBe(0);
   expect((await h.jobs.history(job.id)).map(e=>e.state)).toEqual(['queued','blocked']);
   h.restore();await h.jobs.tick();expect((await h.jobs.get(job.id))!.state).toBe('blocked');
  }finally{await h.close();}
 });
 test(`${name}: the started marker is committed before the adapter runs, and on cancel`,async()=>{
  const h=await make();try{
   const first=await h.enqueue();expect(first.startedAt).toBeNull();
   await h.jobs.tick();expect((await h.jobs.get(first.id))!.startedAt).not.toBeNull();
   const second=await h.enqueue();await h.jobs.cancel(second.id);
   expect((await h.jobs.get(second.id))!).toMatchObject({state:'cancelled'});expect((await h.jobs.get(second.id))!.startedAt).not.toBeNull();
  }finally{await h.close();}
 });
 test(`${name}: a job the adapter has touched is never blocked by the core, even once revoked`,async()=>{
  const h=await make();try{
   const job=await h.enqueue();await h.jobs.tick();expect(await h.reserved(job)).toBeGreaterThan(0);
   h.revoke();await h.jobs.tick();
   const current=(await h.jobs.get(job.id))!;
   expect(current.state).not.toBe('blocked');expect(current.reason).not.toBe('trading_not_granted');
   expect((await h.jobs.history(job.id)).map(e=>e.state)).not.toContain('blocked');
  }finally{await h.close();}
 });
 test(`${name}: a crash right after the adapter reserved, then a revocation before restart, is handed to the adapter, not blocked`,async()=>{
  const h=await make();try{
   h.crashAfterReserve();const job=await h.enqueue();
   void h.jobs.tick();await new Promise(resolve=>setTimeout(resolve,50));
   expect(await h.reserved(job)).toBeGreaterThan(0);
   const before=(await h.jobs.get(job.id))!;expect(before.state).toBe('queued');expect(before.startedAt).not.toBeNull();
   h.revoke();const restarted=await h.restart();await restarted.tick();
   const after=(await restarted.get(job.id))!;
   expect(after.state).not.toBe('blocked');expect((await restarted.history(job.id)).map(e=>e.state)).not.toContain('blocked');
   expect(h.broker.sent()).toBeLessThanOrEqual(1);
  }finally{await h.close();}
 });
}
