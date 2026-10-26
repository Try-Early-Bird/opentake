import {AsyncLocalStorage} from 'node:async_hooks';

// One queue per linked account for whole operations that place
// orders, reserve or move money (read, preview, reserve, confirm, submit). The
// venue queue still orders the individual broker calls inside an operation; it
// cannot protect the operation itself, because another worker's calls can run
// between its steps.
// - Waiting, not failing: a second operation on the same account queues.
// - Member actions go ahead of background work; FIFO within each priority.
// - Several accounts are taken in sorted order, so two operations never deadlock.
// - Nested calls inside a holder (a rule trade calling submit) pass straight
//   through: ownership travels with the async context.
// - A deadline aborts the operation's signal, but its accounts stay held until
//   the work settles. Releasing early could let a second operation plan against
//   the same cash; a slot held past its deadline is reported instead.
// - Never acquire an account inside a database transaction: transactions share
//   one serial queue, so waiting there would stall every other caller.

export type AccountPriority='member'|'background';
export type AccountQueueEvent=
 |{kind:'timed_out';accounts:string[];label:string;deadlineMs:number}
 |{kind:'held_past_deadline';accounts:string[];label:string;heldMs:number}
 |{kind:'waited';accounts:string[];label:string;waitMs:number};
interface Context {held:ReadonlySet<string>;priority:AccountPriority;signal?:AbortSignal}
interface Waiter {priority:AccountPriority;sequence:number;grant:()=>void;cancel:(reason:unknown)=>void}
interface Slot {held:boolean;waiters:Waiter[]}
export interface AccountRunOptions {priority?:AccountPriority;signal?:AbortSignal;deadlineMs?:number;label?:string}

const DEADLINE_MS=120_000,HELD_REPORT_MS=30_000,WAIT_REPORT_MS=5_000;
const order=(a:Waiter,b:Waiter)=>(a.priority===b.priority?0:a.priority==='member'?-1:1)||a.sequence-b.sequence;

export function createAccountQueues(options:{clock?:()=>number;report?:(event:AccountQueueEvent)=>void;deadlineMs?:number;
 /** Called when the first account is taken and when the last one is released. */
 busyChanged?:(busy:boolean)=>void}={}){
 const clock=options.clock??Date.now,report=options.report??(()=>{});
 const context=new AsyncLocalStorage<Context>();
 const slots=new Map<string,Slot>(),running=new Set<AbortController>(),settling=new Set<Promise<unknown>>();
 let sequence=0,closed=false,busy=false;
 const changed=()=>{const now=[...slots.values()].some(s=>s.held);if(now!==busy){busy=now;options.busyChanged?.(now);}};
 const slot=(id:string)=>{let s=slots.get(id);if(!s){s={held:false,waiters:[]};slots.set(id,s);}return s;};
 function release(id:string){
  const s=slot(id),next=s.waiters.shift();
  if(next){next.grant();return;}
  s.held=false;if(!s.waiters.length)slots.delete(id);changed();
 }
 function acquire(id:string,priority:AccountPriority,signal?:AbortSignal):Promise<void>{
  const s=slot(id);
  if(!s.held){s.held=true;changed();return Promise.resolve();}
  return new Promise<void>((resolve,reject)=>{
   const waiter:Waiter={priority,sequence:sequence++,
    grant:()=>{signal?.removeEventListener('abort',abort);resolve();},
    cancel:reason=>{signal?.removeEventListener('abort',abort);reject(reason);}};
   const abort=()=>{const index=s.waiters.indexOf(waiter);if(index>=0){s.waiters.splice(index,1);waiter.cancel(signal?.reason??new DOMException('Account work cancelled','AbortError'));}};
   s.waiters.push(waiter);s.waiters.sort(order);
   signal?.addEventListener('abort',abort,{once:true});
  });
 }
 const service={
  /** Run `work` holding every account in `accountIds`. */
  async run<T>(accountIds:readonly string[],work:(signal:AbortSignal)=>Promise<T>,run:AccountRunOptions={}):Promise<T>{
   const outer=context.getStore(),label=run.label??'account operation';
   const priority=run.priority??outer?.priority??'background';
   const needed=[...new Set(accountIds)].filter(id=>!outer?.held.has(id)).sort();
   if(outer&&!needed.length)return work(run.signal??outer.signal??new AbortController().signal);
   // Taking another account mid-operation would break the sorted order and can deadlock.
   if(outer&&outer.held.size)throw new Error(`Take every account at the start of ${label}.`);
   if(closed)throw new DOMException('Account queues closed','AbortError');
   const waitStart=clock(),taken:string[]=[];
   try{for(const id of needed){await acquire(id,priority,run.signal??outer?.signal);taken.push(id);}}
   catch(error){for(const id of taken.reverse())release(id);throw error;}
   const waitMs=clock()-waitStart;if(waitMs>=WAIT_REPORT_MS)report({kind:'waited',accounts:needed,label,waitMs});
   const controller=new AbortController(),deadlineMs=run.deadlineMs??options.deadlineMs??DEADLINE_MS,started=clock();
   const parent=run.signal??outer?.signal,forward=()=>controller.abort(parent?.reason);
   parent?.addEventListener('abort',forward,{once:true});if(parent?.aborted)forward();
   const timer=setTimeout(()=>{report({kind:'timed_out',accounts:needed,label,deadlineMs});controller.abort(new DOMException('Account work timed out','TimeoutError'));},deadlineMs);
   running.add(controller);
   const task=context.run({held:new Set([...(outer?.held??[]),...needed]),priority,signal:controller.signal},()=>Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work(controller.signal);}));
   settling.add(task);
   try{return await task;}
   finally{
    settling.delete(task);clearTimeout(timer);running.delete(controller);parent?.removeEventListener('abort',forward);
    const heldMs=clock()-started;if(heldMs>deadlineMs+HELD_REPORT_MS)report({kind:'held_past_deadline',accounts:needed,label,heldMs});
    for(const id of needed.reverse())release(id);
   }
  },
  /** Run `work` so every account operation it starts goes ahead of background work. */
  member<T>(work:()=>Promise<T>):Promise<T>{
   const outer=context.getStore();
   return context.run({held:outer?.held??new Set(),priority:'member',signal:outer?.signal},work);
  },
  /** Run `work` outside any account operation or member context. Background loops start
   *  their runs this way: a timer set inside a holder would otherwise inherit its accounts. */
  detached<T>(work:()=>T):T{return context.exit(work);},
  /** The cancellation signal of the account operation this call runs inside, if any. */
  signal:():AbortSignal|undefined=>context.getStore()?.signal,
  busy:(accountId?:string)=>accountId===undefined?[...slots.values()].some(s=>s.held):!!slots.get(accountId)?.held,
  stats:()=>({held:[...slots].filter(([,s])=>s.held).map(([id])=>id),waiting:[...slots.values()].reduce((n,s)=>n+s.waiters.length,0)}),
  /** Stop taking work, abort running operations and wait up to `deadlineMs` for them to settle. */
  async close(deadlineMs=5_000):Promise<boolean>{
   closed=true;
   for(const s of slots.values())for(const w of s.waiters.splice(0))w.cancel(new DOMException('Account queues closed','AbortError'));
   for(const controller of running)controller.abort(new DOMException('Shutting down','AbortError'));
   let timer:ReturnType<typeof setTimeout>|undefined;
   const settled=await Promise.race([Promise.allSettled([...settling]).then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),deadlineMs);})]);
   clearTimeout(timer);return settled;
  },
 };
 return service;
}
export type AccountQueues=ReturnType<typeof createAccountQueues>;
