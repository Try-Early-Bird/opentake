// One background worker's loop. It runs, waits its interval, and
// runs again; runs never overlap. `wake()` asks for a run soon (coalesced), so
// events drive the work and the interval is only a backup. Each run gets an
// AbortSignal with a deadline: past it the run is aborted and reported, and the
// loop waits for it to settle rather than starting a second one beside it.
// Durable state lives in the worker's own tables, so an aborted run resumes later.

export type WorkerEvent=
 |{kind:'failed';worker:string;error:unknown;durationMs:number}
 |{kind:'timed_out';worker:string;deadlineMs:number}
 |{kind:'slow';worker:string;durationMs:number;deadlineMs:number}
 |{kind:'stuck';worker:string;heldMs:number};
export interface WorkerLoopOptions {
 name:string;
 intervalMs:number;
 /** How long one run may take before it is aborted. */
 deadlineMs:number;
 run:(signal:AbortSignal)=>Promise<unknown>;
 /** Checked before each run; a disabled loop skips the run and waits its interval. */
 enabled?:()=>boolean;
 report?:(event:WorkerEvent)=>void;
 clock?:()=>number;
 /** Starts each run in a clean async context (see AccountQueues.detached). */
 isolate?:<T>(work:()=>T)=>T;
}
const STUCK_REPORT_MS=30_000,SLOW_SHARE=0.5;

export function createWorkerLoop(options:WorkerLoopOptions){
 const clock=options.clock??Date.now,report=options.report??(()=>{});
 let timer:ReturnType<typeof setTimeout>|undefined,dueAt=Infinity;
 let current:Promise<void>|undefined,controller:AbortController|undefined;
 let started=false,suspended=false,closed=false,again=false;
 const stats={runs:0,failures:0,timeouts:0,lastDurationMs:0,maxDurationMs:0,lastRunAt:null as number|null};

 function schedule(delayMs:number){
  if(!started||suspended||closed)return;
  const at=clock()+Math.max(0,delayMs);
  if(timer&&at>=dueAt)return;
  if(timer)clearTimeout(timer);
  dueAt=at;timer=setTimeout(()=>{timer=undefined;dueAt=Infinity;void tick();},Math.max(0,delayMs));
 }
 async function once(){
  const begin=clock();controller=new AbortController();const signal=controller.signal;
  const deadline=setTimeout(()=>{stats.timeouts++;report({kind:'timed_out',worker:options.name,deadlineMs:options.deadlineMs});controller?.abort(new DOMException(`${options.name} timed out`,'TimeoutError'));},options.deadlineMs);
  const stuck=setTimeout(()=>report({kind:'stuck',worker:options.name,heldMs:clock()-begin}),options.deadlineMs+STUCK_REPORT_MS);
  try{await (options.isolate?options.isolate(()=>options.run(signal)):options.run(signal));}
  catch(error){if(!signal.aborted){stats.failures++;report({kind:'failed',worker:options.name,error,durationMs:clock()-begin});}}
  finally{
   clearTimeout(deadline);clearTimeout(stuck);controller=undefined;
   const durationMs=clock()-begin;stats.runs++;stats.lastDurationMs=durationMs;stats.maxDurationMs=Math.max(stats.maxDurationMs,durationMs);stats.lastRunAt=begin;
   if(durationMs>=options.deadlineMs*SLOW_SHARE&&durationMs<options.deadlineMs)report({kind:'slow',worker:options.name,durationMs,deadlineMs:options.deadlineMs});
  }
 }
 function tick():Promise<void>{
  if(current){again=true;return current;}
  if(closed||suspended)return Promise.resolve();
  if(options.enabled&&!options.enabled()){schedule(options.intervalMs);return Promise.resolve();}
  again=false;
  current=once().finally(()=>{current=undefined;schedule(again?0:options.intervalMs);again=false;});
  return current;
 }
 return {
  name:options.name,
  /** Start the loop; the first run follows after `delayMs` (default: the interval). */
  start(delayMs=options.intervalMs){if(closed)return;started=true;schedule(delayMs);},
  /** Run as soon as possible, or after `delayMs`; never sooner than an earlier request. */
  wake(delayMs=0){if(current&&delayMs===0){again=true;return;}schedule(delayMs);},
  /** Stop scheduling runs; a run in progress finishes. */
  suspend(){suspended=true;if(timer){clearTimeout(timer);timer=undefined;dueAt=Infinity;}},
  /** Resume and run once promptly, catching up on work due while suspended. */
  resume(){if(!suspended)return;suspended=false;schedule(0);},
  running:()=>!!current,
  stats:()=>({...stats,running:!!current,suspended}),
  /** Run now and wait for it (tests and member-requested runs). */
  runNow:()=>tick(),
  /** Stop, abort a run in progress and wait up to `deadlineMs` for it to settle. */
  async close(deadlineMs=5_000):Promise<boolean>{
   closed=true;if(timer){clearTimeout(timer);timer=undefined;}
   controller?.abort(new DOMException('Shutting down','AbortError'));
   if(!current)return true;
   let wait:ReturnType<typeof setTimeout>|undefined;
   const settled=await Promise.race([current.then(()=>true),new Promise<boolean>(resolve=>{wait=setTimeout(()=>resolve(false),deadlineMs);})]);
   clearTimeout(wait);return settled;
  },
 };
}
export type WorkerLoop=ReturnType<typeof createWorkerLoop>;
