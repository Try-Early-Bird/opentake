import {expect,test,vi} from 'vitest';
import {createPreviewQueue} from '../../src/renderer/src/strategies/preview-queue';
test('serializes previews and skips superseded inputs',async()=>{
 const queue=createPreviewQueue();let release!:()=>void;let active=true;
 const first=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
 const stale=vi.fn(async()=>2),latest=vi.fn(async()=>3);
 const a=queue(first,()=>true);await Promise.resolve();
 const b=queue(stale,()=>active),c=queue(latest,()=>true);active=false;
 expect(latest).not.toHaveBeenCalled();release();
 expect(await Promise.all([a,b,c])).toEqual([undefined,undefined,3]);
 expect(stale).not.toHaveBeenCalled();expect(latest).toHaveBeenCalledTimes(1);
});
test('waits out busy connections without exposing a transient failure',async()=>{
 vi.useFakeTimers();try{
 const work=vi.fn().mockRejectedValueOnce(Error('Another Coinbase connection operation is running.')).mockResolvedValue('preview');
 const result=createPreviewQueue()(work,()=>true);await vi.runAllTimersAsync();
 expect(await result).toBe('preview');expect(work).toHaveBeenCalledTimes(2);
 }finally{vi.useRealTimers();}
});
test('does not retry validation errors and allows the next preview',async()=>{
 const queue=createPreviewQueue(),work=vi.fn().mockRejectedValue(Error('Insufficient funds'));
 await expect(queue(work,()=>true)).rejects.toThrow('Insufficient funds');
 expect(work).toHaveBeenCalledTimes(1);expect(await queue(async()=>3,()=>true)).toBe(3);
});
test('stops busy retries after the input is superseded',async()=>{
 vi.useFakeTimers();try{let active=true;const work=vi.fn().mockRejectedValue(Error('Another Coinbase connection operation is running.'));
 const result=createPreviewQueue()(work,()=>active);await vi.advanceTimersByTimeAsync(0);active=false;await vi.runAllTimersAsync();
 expect(await result).toBeUndefined();expect(work).toHaveBeenCalledTimes(1);
 }finally{vi.useRealTimers();}
});

test('keeps busy previews loading through longer contention and reports waiting',async()=>{
 vi.useFakeTimers();try{
 let calls=0;const waiting=vi.fn();
 const result=createPreviewQueue()(async()=>{if(calls++<10)throw Error('Another Coinbase connection operation is running.');return 'ready';},()=>true,waiting);
 await vi.runAllTimersAsync();expect(await result).toBe('ready');expect(waiting).toHaveBeenCalledTimes(10);
 }finally{vi.useRealTimers();}
});
test('busy preview retries are bounded and a later retry can succeed',async()=>{
 vi.useFakeTimers();try{
 const queue=createPreviewQueue(),work=vi.fn().mockRejectedValue(Error('Another Coinbase connection operation is running.'));
 const result=queue(work,()=>true);const assertion=expect(result).rejects.toThrow('Coinbase is still busy');
 await vi.runAllTimersAsync();await assertion;
 expect(work.mock.calls.length).toBeLessThan(40);
 expect(await queue(async()=> 'ready',()=>true)).toBe('ready');
 }finally{vi.useRealTimers();}
});
