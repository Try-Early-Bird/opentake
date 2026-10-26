import {expect,test} from 'vitest';
import {createVenueQueue} from '../../src/main/venue-queue';
const gate=()=>{let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});return {promise,release};};
test('orders precede pending quotes, FIFO breaks ties, aged facts cannot starve',async()=>{
 let now=0;const queue=createVenueQueue(()=>now),hold=gate(),order:string[]=[];
 const first=queue.submit(()=>hold.promise);
 const fact=queue.submit(async()=>{order.push('fact');},'facts');now=30_000;
 const quote=queue.submit(async()=>{order.push('quote');},'quotes');
 const a=queue.submit(async()=>{order.push('order1');},'order'),b=queue.submit(async()=>{order.push('order2');},'order');
 hold.release();await Promise.all([first,fact,quote,a,b]);expect(order).toEqual(['fact','order1','order2','quote']);
 expect(queue.stats()).toMatchObject({completed:5,queued:0});await queue.close();
});
test('aborting queued work never calls it; cancellation lets an active order record its result',async()=>{
 const queue=createVenueQueue(),hold=gate();let called=false;
 const order=queue.submit(async signal=>{await hold.promise;expect(signal.aborted).toBe(false);return 'accepted';},'order');
 const controller=new AbortController();const read=queue.submit(async()=>{called=true;},'facts',controller.signal);
 const rejected=expect(read).rejects.toThrow('cancelled');controller.abort();queue.cancel();hold.release();
 expect(await order).toBe('accepted');await rejected;expect(called).toBe(false);await queue.close();
});
import {createReadCoalescer} from '../../src/main/venue-queue';
test('identical reads share work while cancellation belongs to each caller',async()=>{
 const reads=createReadCoalescer(),hold=gate();let calls=0;
 const work=async(signal:AbortSignal)=>{calls++;await hold.promise;expect(signal.aborted).toBe(false);return 42;};
 const controller=new AbortController();const first=reads.run('quotes',work,controller.signal),second=reads.run('quotes',work);
 const aborted=expect(first).rejects.toThrow();controller.abort();hold.release();await aborted;
 expect(await second).toBe(42);expect(calls).toBe(1);expect(reads.stats().coalesced).toBe(1);
});
test('the run limit starts when work starts, and a hung call frees the queue after the grace period',async()=>{
 const queue=createVenueQueue(Date.now,20),hold=gate();let signalled=false;
 const first=expect(queue.submit(()=>hold.promise,'sync',undefined,50)).rejects.toThrow('timed out');
 // Waits ~50 ms behind the first task but gets its own 50 ms once it runs.
 const second=queue.submit(async()=>{await new Promise(r=>setTimeout(r,30));return 'done';},'sync',undefined,50);
 const hung=expect(queue.submit(signal=>new Promise(()=>{signal.addEventListener('abort',()=>{signalled=true;});}),'order',undefined,10)).rejects.toThrow('timed out');
 const third=queue.submit(async()=>'after','facts');
 await first;hold.release();expect(await second).toBe('done');
 await hung;expect(signalled).toBe(true);expect(await third).toBe('after');await queue.settled();
 expect(queue.stats()).toMatchObject({timedOut:2,completed:2,queued:0,running:null});
});
test('closing aborts a running read, drops queued work including unsent orders, and refuses new work',async()=>{
 const queue=createVenueQueue();
 const read=expect(queue.submit(signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')))),'sync')).rejects.toThrow('aborted');
 const unsent=expect(queue.submit(async()=>'placed','order')).rejects.toThrow('cancelled');
 await queue.close();await read;await unsent;
 await expect(queue.submit(async()=>1)).rejects.toThrow('closed');
});
test('closing lets an order already being sent finish',async()=>{
 const queue=createVenueQueue(),hold=gate();
 const order=queue.submit(async signal=>{await hold.promise;expect(signal.aborted).toBe(false);return 'placed';},'order');
 const closing=queue.close();hold.release();expect(await order).toBe('placed');await closing;
});
test('managed writes keep the queue locked after timeout until the transport settles',async()=>{
 const queue=createVenueQueue(Date.now,1),hold=gate();let aborted=false,secondStarted=false;
 const first=queue.submit(async signal=>{signal.addEventListener('abort',()=>{aborted=true;});await hold.promise;return 'known-id';},'facts',undefined,5,true);
 const second=queue.submit(async()=>{secondStarted=true;});
 await new Promise(r=>setTimeout(r,20));
 expect(aborted).toBe(true);expect(secondStarted).toBe(false);
 hold.release();expect(await first).toBe('known-id');await second;await queue.close();
});


test('clearing shared reads immediately rejects every waiter even when work ignores abort',async()=>{
 const reads=createReadCoalescer(),hold=gate();let calls=0;
 const load=async()=>{calls++;await hold.promise;return 'old';};
 const first=reads.run('facts',load),second=reads.run('facts',load);
 const rejected=Promise.all([expect(first).rejects.toThrow(),expect(second).rejects.toThrow()]);
 await Promise.resolve();expect(calls).toBe(1);
 reads.clear();await rejected;
 const replacement=gate();let replacementCalls=0;
 const fresh=()=>{replacementCalls++;return replacement.promise.then(()=>'fresh');};
 const third=reads.run('facts',fresh);
 hold.release();await Promise.resolve();await Promise.resolve();
 const fourth=reads.run('facts',fresh);
 replacement.release();expect(await third).toBe('fresh');expect(await fourth).toBe('fresh');
 expect(replacementCalls).toBe(1);
});

test('clearing before a queued read starts prevents the provider call',async()=>{
 const reads=createReadCoalescer();let calls=0;
 const pending=reads.run('facts',async()=>{calls++;return true;});
 const rejected=expect(pending).rejects.toThrow();reads.clear();await rejected;
 await Promise.resolve();expect(calls).toBe(0);
});
