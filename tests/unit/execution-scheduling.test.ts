// Worker loops and account queues. Synthetic work only.
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {createWorkerLoop,type WorkerEvent} from '../../src/main/execution/worker-loop';
import {createAccountQueues,type AccountQueueEvent} from '../../src/main/execution/account-queues';

beforeEach(()=>{vi.useFakeTimers();});
afterEach(()=>{vi.useRealTimers();});
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const settle=()=>vi.advanceTimersByTimeAsync(0);

test('a loop runs on its interval, never overlaps, and a wake during a run reruns once afterwards',async()=>{
 let runs=0,active=0,maxActive=0;const gate=deferred();
 const loop=createWorkerLoop({name:'w',intervalMs:1000,deadlineMs:10_000,run:async()=>{runs++;active++;maxActive=Math.max(maxActive,active);if(runs===1)await gate.promise;active--;}});
 loop.start(0);await settle();expect(runs).toBe(1);
 loop.wake();loop.wake();await vi.advanceTimersByTimeAsync(5000);expect(runs).toBe(1);
 gate.resolve();await settle();expect(runs).toBe(2);expect(maxActive).toBe(1);
 await vi.advanceTimersByTimeAsync(999);expect(runs).toBe(2);await vi.advanceTimersByTimeAsync(1);expect(runs).toBe(3);
 await loop.close();
});

test('wake runs early and coalesces; a later wake never delays an earlier one',async()=>{
 let runs=0;const loop=createWorkerLoop({name:'w',intervalMs:30_000,deadlineMs:10_000,run:async()=>{runs++;}});
 loop.start();loop.wake(2000);loop.wake(8000);loop.wake(1000);
 await vi.advanceTimersByTimeAsync(1000);expect(runs).toBe(1);
 await vi.advanceTimersByTimeAsync(10_000);expect(runs).toBe(1);
 await vi.advanceTimersByTimeAsync(20_000);expect(runs).toBe(2);
 await loop.close();
});

test('a run past its deadline is aborted and reported; the loop waits for it, then keeps running',async()=>{
 const events:WorkerEvent[]=[];let runs=0;const signals:AbortSignal[]=[];const hang=deferred();
 const loop=createWorkerLoop({name:'w',intervalMs:1000,deadlineMs:2000,report:e=>events.push(e),run:async signal=>{runs++;signals.push(signal);if(runs===1)await hang.promise;}});
 loop.start(0);await settle();
 await vi.advanceTimersByTimeAsync(2000);expect(signals[0].aborted).toBe(true);expect(events).toContainEqual({kind:'timed_out',worker:'w',deadlineMs:2000});
 await vi.advanceTimersByTimeAsync(5000);expect(runs).toBe(1);
 await vi.advanceTimersByTimeAsync(30_000);expect(events.some(e=>e.kind==='stuck')).toBe(true);
 hang.resolve();await settle();await vi.advanceTimersByTimeAsync(1000);expect(runs).toBe(2);
 expect(events.filter(e=>e.kind==='failed')).toEqual([]);
 await loop.close();
});

test('failures are reported and do not stop the loop; disabled loops skip runs',async()=>{
 const events:WorkerEvent[]=[];let runs=0,enabled=true;
 const loop=createWorkerLoop({name:'w',intervalMs:1000,deadlineMs:5000,enabled:()=>enabled,report:e=>events.push(e),run:async()=>{runs++;throw Error('synthetic');}});
 loop.start(0);await settle();await vi.advanceTimersByTimeAsync(1000);expect(runs).toBe(2);
 expect(events.filter(e=>e.kind==='failed')).toHaveLength(2);
 enabled=false;await vi.advanceTimersByTimeAsync(5000);expect(runs).toBe(2);
 enabled=true;await vi.advanceTimersByTimeAsync(1000);expect(runs).toBe(3);
 await loop.close();
});

test('suspend stops scheduling, resume catches up once, close aborts and is bounded',async()=>{
 let runs=0;const signals:AbortSignal[]=[];const hang=deferred();
 const loop=createWorkerLoop({name:'w',intervalMs:1000,deadlineMs:60_000,run:async signal=>{runs++;signals.push(signal);if(runs===2)await hang.promise;}});
 loop.start(0);await settle();expect(runs).toBe(1);
 loop.suspend();await vi.advanceTimersByTimeAsync(10_000);expect(runs).toBe(1);
 loop.resume();await settle();expect(runs).toBe(2);
 const closing=loop.close(5000);expect(signals[1].aborted).toBe(true);
 await vi.advanceTimersByTimeAsync(5000);expect(await closing).toBe(false);
 hang.resolve();await settle();await vi.advanceTimersByTimeAsync(10_000);expect(runs).toBe(2);
});

test('one account runs one operation at a time; different accounts run in parallel',async()=>{
 const queues=createAccountQueues(),order:string[]=[];const first=deferred();
 const a1=queues.run(['a'],async()=>{order.push('a1:start');await first.promise;order.push('a1:end');});
 const a2=queues.run(['a'],async()=>{order.push('a2');});
 const b=queues.run(['b'],async()=>{order.push('b');});
 await settle();expect(order).toEqual(['a1:start','b']);expect(queues.busy('a')).toBe(true);
 first.resolve();await Promise.all([a1,a2,b]);expect(order).toEqual(['a1:start','b','a1:end','a2']);expect(queues.busy()).toBe(false);
});

test('member actions go ahead of queued background work, FIFO within a priority',async()=>{
 const queues=createAccountQueues(),order:string[]=[];const hold=deferred();
 const running=queues.run(['a'],()=>hold.promise);
 const work=[queues.run(['a'],async()=>{order.push('bg1');}),queues.run(['a'],async()=>{order.push('bg2');}),
  queues.member(()=>queues.run(['a'],async()=>{order.push('member1');})),queues.run(['a'],async()=>{order.push('member2');},{priority:'member'})];
 await settle();hold.resolve();await Promise.all([running,...work]);
 expect(order).toEqual(['member1','member2','bg1','bg2']);
});

test('multi-account operations in opposite orders never deadlock',async()=>{
 const queues=createAccountQueues(),done:string[]=[];
 await Promise.all([
  queues.run(['b','a'],async()=>{await settle();done.push('ba');}),
  queues.run(['a','b'],async()=>{await settle();done.push('ab');}),
  queues.run(['b'],async()=>{done.push('b');}),
 ].map(p=>p.then(()=>undefined)));
 await vi.runAllTimersAsync();expect(done.sort()).toEqual(['ab','b','ba']);expect(queues.busy()).toBe(false);
});

test('nested calls inside a holder pass through; taking another account mid-operation is refused',async()=>{
 const queues=createAccountQueues();let inner=false;
 await queues.run(['a'],async()=>{await queues.run(['a'],async()=>{inner=true;});});
 expect(inner).toBe(true);
 await expect(queues.run(['a'],()=>queues.run(['a','b'],async()=>{}))).rejects.toThrow('Take every account');
 expect(queues.busy()).toBe(false);
});

test('a deadline aborts the work but keeps the account until it settles, and is reported',async()=>{
 const events:AccountQueueEvent[]=[];const queues=createAccountQueues({report:e=>events.push(e)}),hang=deferred();let signal!:AbortSignal,second=false;
 const first=queues.run(['a'],async s=>{signal=s;await hang.promise;},{deadlineMs:1000,label:'slow submit'});
 const next=queues.run(['a'],async()=>{second=true;});
 await vi.advanceTimersByTimeAsync(1000);expect(signal.aborted).toBe(true);expect(events).toContainEqual({kind:'timed_out',accounts:['a'],label:'slow submit',deadlineMs:1000});
 await vi.advanceTimersByTimeAsync(60_000);expect(second).toBe(false);expect(queues.busy('a')).toBe(true);
 hang.resolve();await first;await next;expect(second).toBe(true);
 expect(events.some(e=>e.kind==='held_past_deadline')).toBe(true);expect(events.some(e=>e.kind==='waited')).toBe(true);
});

test('a caller can cancel while waiting; close rejects waiters and aborts running work',async()=>{
 const queues=createAccountQueues(),hold=deferred(),controller=new AbortController();let signal!:AbortSignal;
 const running=queues.run(['a'],async s=>{signal=s;await hold.promise;});
 const cancelled=queues.run(['a'],async()=>{},{signal:controller.signal});
 const waiting=queues.run(['a'],async()=>{});
 controller.abort();await expect(cancelled).rejects.toThrow();
 const closing=queues.close(1000);expect(signal.aborted).toBe(true);await expect(waiting).rejects.toThrow('closed');
 hold.resolve();expect(await closing).toBe(true);await running;
 await expect(queues.run(['a'],async()=>{})).rejects.toThrow('closed');
});

test('busyChanged reports the first account taken and the last released, so a power blocker spans the work',async()=>{
 const changes:boolean[]=[];const queues=createAccountQueues({busyChanged:busy=>changes.push(busy)});const hold=deferred();
 const a=queues.run(['a'],()=>hold.promise),b=queues.run(['b'],async()=>{}),a2=queues.run(['a'],async()=>{});
 await settle();expect(changes).toEqual([true]);
 hold.resolve();await Promise.all([a,b,a2]);expect(changes).toEqual([true,false]);
});
