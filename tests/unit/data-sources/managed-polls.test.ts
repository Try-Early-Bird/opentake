import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createManagedPolls } from '../../../src/main/data-sources/managed-polls';
const instances: ReturnType<typeof createManagedPolls>[] = [];
function create(...args:Parameters<typeof createManagedPolls>) {const instance=createManagedPolls(args[0],args[1],{clock:{wall:()=>Date.now(),monotonic:()=>Date.now()},...args[2]});instances.push(instance);return instance;}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));});
afterEach(async()=>{await Promise.all(instances.splice(0).map(instance=>instance.close()));vi.useRealTimers();});
test('managed polls preserve five/30 second cadence, start once, and honor host availability',async()=>{
 let enabled=true;
 const account=vi.fn(async()=>{}),prices=vi.fn(async()=>{});
 const polls=create([{id:'accounts',intervalMs:5000,run:account},{id:'prices',intervalMs:30000,run:prices}],()=>enabled);
 polls.start();polls.start();await vi.advanceTimersByTimeAsync(0);
 expect(account).toHaveBeenCalledTimes(1);expect(prices).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(30000);expect(account).toHaveBeenCalledTimes(7);expect(prices).toHaveBeenCalledTimes(2);
 enabled=false;await vi.advanceTimersByTimeAsync(30000);expect(account).toHaveBeenCalledTimes(7);expect(prices).toHaveBeenCalledTimes(2);
 enabled=true;await vi.advanceTimersByTimeAsync(5000);expect(account).toHaveBeenCalledTimes(8);
});
test('slow polls never overlap through suspend/resume; independent jobs progress and shutdown drains',async()=>{
 let finish!:()=>void;
 const slow=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;})),fast=vi.fn(async()=>{});
 const polls=create([{id:'slow',intervalMs:5000,run:slow},{id:'fast',intervalMs:5000,run:fast}],()=>true);
 polls.start();await vi.advanceTimersByTimeAsync(10000);expect(slow).toHaveBeenCalledTimes(1);expect(fast).toHaveBeenCalledTimes(3);
 polls.suspend();await vi.advanceTimersByTimeAsync(30000);expect(fast).toHaveBeenCalledTimes(3);
 polls.resume();await vi.advanceTimersByTimeAsync(10000);expect(slow).toHaveBeenCalledTimes(1);expect(fast).toHaveBeenCalledTimes(6);
 let closed=false;const closing=polls.close().then(()=>{closed=true;});await vi.advanceTimersByTimeAsync(0);expect(closed).toBe(false);
 finish();await closing;expect(closed).toBe(true);
 await vi.advanceTimersByTimeAsync(60000);expect(slow).toHaveBeenCalledTimes(1);expect(fast).toHaveBeenCalledTimes(6);
});
test('a failed job retries without stopping independent providers',async()=>{
 const failed=vi.fn(async()=>{throw Error('fixture');}),healthy=vi.fn(async()=>{});
 const polls=create([{id:'failed',intervalMs:5000,run:failed},{id:'healthy',intervalMs:5000,run:healthy}],()=>true);
 polls.start();await vi.advanceTimersByTimeAsync(15000);
 expect(failed.mock.calls.length).toBeGreaterThan(1);expect(healthy).toHaveBeenCalledTimes(4);
});
test('saved policy changes pause and retime upcoming checks without new runtime acquisitions',async()=>{
 const run=vi.fn(async()=>{});
 let policy={id:'coinbase-account-sync' as const,collection:'automatic' as 'automatic'|'off',intervalMs:5000,revision:0};
 const polls=create([{id:policy.id,intervalMs:5000,run}],()=>true,{policy:()=>policy});
 polls.start();await vi.advanceTimersByTimeAsync(0);expect(run).toHaveBeenCalledTimes(1);
 policy={...policy,intervalMs:60000,revision:1};
 await vi.advanceTimersByTimeAsync(55000);expect(run).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(5000);expect(run).toHaveBeenCalledTimes(2);
 policy={...policy,collection:'off',revision:2};
 await vi.advanceTimersByTimeAsync(120000);expect(run).toHaveBeenCalledTimes(2);
 policy={...policy,collection:'automatic',intervalMs:5000,revision:3};
 await vi.advanceTimersByTimeAsync(5000);expect(run).toHaveBeenCalledTimes(3);
});
