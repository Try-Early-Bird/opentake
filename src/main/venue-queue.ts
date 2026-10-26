/** Serial venue access. Orders are never retried or coalesced here. */
export type VenuePriority='order'|'reconcile'|'sync'|'quotes'|'facts';
const rank:Record<VenuePriority,number>={order:0,reconcile:1,sync:2,quotes:3,facts:4};
interface Job {priority:VenuePriority;at:number;sequence:number;run:()=>Promise<void>;cancel:()=>void}
// A venue call takes seconds; a task gets a minute from when it starts (sign-in, which waits
// on the member, passes its own). A timed-out task that ignores its abort frees the queue
// after releaseMs, so one hung call cannot hold every other task.
const RUN_MS=60_000;
export function createVenueQueue(clock=()=>Date.now(),releaseMs=5_000){
 const pending:Job[]=[];
 let active:Promise<void>|undefined,activeJob:Job|undefined,sequence=0,closed=false;
 const counts={completed:0,cancelled:0,failed:0,timedOut:0,totalWaitMs:0,maxWaitMs:0};
 function pump(){
  if(active||!pending.length)return;
  // Age waiting work one priority every 5 s; even facts eventually beat new orders.
  pending.sort((a,b)=>(rank[a.priority]-Math.floor((clock()-a.at)/5000))-(rank[b.priority]-Math.floor((clock()-b.at)/5000))||a.sequence-b.sequence);
  const job=pending.shift()!;activeJob=job;
  const wait=Math.max(0,clock()-job.at);counts.totalWaitMs+=wait;counts.maxWaitMs=Math.max(counts.maxWaitMs,wait);
  active=job.run().finally(()=>{active=undefined;activeJob=undefined;pump();});
 }
 return {
  submit<T>(work:(signal:AbortSignal)=>Promise<T>,priority:VenuePriority='sync',signal?:AbortSignal,runMs=RUN_MS,waitForSettlement=false):Promise<T>{
   if(closed)return Promise.reject(new Error('Venue queue closed'));
   return new Promise<T>((resolve,reject)=>{
    const controller=new AbortController();let started=false,finished=false;
    const finish=()=>{finished=true;signal?.removeEventListener('abort',abort);};
    const abort=()=>{
     controller.abort();
     if(!started&&!finished){const index=pending.indexOf(job);if(index>=0)pending.splice(index,1);counts.cancelled++;finish();reject(new DOMException('Venue work cancelled','AbortError'));}
    };
    const job:Job={priority,at:clock(),sequence:sequence++,cancel:abort,run:()=>new Promise<void>(release=>{
     started=true;let grace:ReturnType<typeof setTimeout>|undefined;
     const timer=setTimeout(()=>{
      counts.timedOut++;controller.abort();
      // Managed non-idempotent writes retain the queue until transport settles.
      if(waitForSettlement)return;
      if(!finished){finish();reject(new DOMException('Venue work timed out','TimeoutError'));}
      grace=setTimeout(release,releaseMs);
     },runMs);
     (async()=>{controller.signal.throwIfAborted();return work(controller.signal);})()
      .then(value=>{if(!finished){counts.completed++;finish();resolve(value);}},error=>{if(!finished){counts.failed++;finish();reject(error);}})
      .finally(()=>{clearTimeout(timer);clearTimeout(grace);release();});
    })};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted){abort();return;}
    pending.push(job);pump();
   });
  },
  cancel(){for(const job of [...pending])job.cancel();if(activeJob?.priority!=='order')activeJob?.cancel();},
  async settled(){while(active)await active;},
  async close(){closed=true;this.cancel();await this.settled();},
  stats:()=>({...counts,queued:pending.length,running:activeJob?.priority??null}),
 };
}

/** Fan out one pending read; a caller's cancellation does not cancel other subscribers. */
export function createReadCoalescer(){
 const reads=new Map<string,{promise:Promise<unknown>;controller:AbortController;users:number}>();
 let coalesced=0;
 return {
  run<T>(key:string,work:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
   if(signal?.aborted)return Promise.reject(signal.reason??new DOMException('Cancelled','AbortError'));
   let entry=reads.get(key);
   if(!entry){
    const controller=new AbortController();
    entry={controller,users:0,promise:Promise.resolve().then(()=>{controller.signal.throwIfAborted();return work(controller.signal);})};
    const created=entry;reads.set(key,created);
    void created.promise.finally(()=>{if(reads.get(key)===created)reads.delete(key);}).catch(()=>{});
   }else coalesced++;
   const current=entry;current.users++;
   return new Promise<T>((resolve,reject)=>{
    let done=false;
    const finish=()=>{if(done)return false;done=true;signal?.removeEventListener('abort',abort);current.controller.signal.removeEventListener('abort',invalidated);current.users--;return true;};
    const abort=()=>{if(finish()){reject(signal?.reason??new DOMException('Cancelled','AbortError'));if(!current.users){if(reads.get(key)===current)reads.delete(key);current.controller.abort();}}};
    // Invalidation must release waiters even when the transport ignores abort.
    const invalidated=()=>{if(finish())reject(current.controller.signal.reason??new DOMException('Read invalidated','AbortError'));};
    signal?.addEventListener('abort',abort,{once:true});
    current.controller.signal.addEventListener('abort',invalidated,{once:true});
    if(current.controller.signal.aborted)invalidated();
    current.promise.then(value=>{if(finish())resolve(value as T);},error=>{if(finish())reject(error);});
   });
  },
  clear(){for(const entry of reads.values())entry.controller.abort();reads.clear();},
  stats:()=>({coalesced}),
 };
}
