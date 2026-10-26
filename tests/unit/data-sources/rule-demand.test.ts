import {test,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createDataSourceHostService} from '../../../src/main/data-sources/host-service';
import {definition,fakeHttp,sample} from './fixtures';
test('host-owned rule demand keeps a feed alive without a view and shares the existing transport',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
 const feed=definition({sourceId:randomUUID(),pollIntervalMs:15000}),ref={sourceId:feed.sourceId,feedId:feed.feedId,configVersion:1,schemaVersion:1};
 const poll=vi.fn(async context=>{context.connected();context.emit(sample('42'));});
 const host=createDataSourceHostService([fakeHttp(poll)],[feed],{runtime:{random:()=>0.5}});
 try{
  host.ruleDemand([ref,ref]);await vi.advanceTimersByTimeAsync(0);expect(poll).toHaveBeenCalledTimes(1);
  expect(host.peek([ref])[0]?.latest?.payload).toEqual({kind:'metric',value:'42'});
  const client=randomUUID();host.dispatch('dataSources:acquire',[ref],client);await vi.advanceTimersByTimeAsync(0);expect(poll).toHaveBeenCalledTimes(1);
  host.dispatch('dataSources:drop-client',[],client);await vi.advanceTimersByTimeAsync(15000);expect(poll).toHaveBeenCalledTimes(2);
  host.ruleDemand([]);await vi.advanceTimersByTimeAsync(60000);expect(poll).toHaveBeenCalledTimes(2);
  host.ruleDemand([{...ref,configVersion:2}]);await vi.advanceTimersByTimeAsync(0);expect(poll).toHaveBeenCalledTimes(2);
 }finally{host.close();vi.useRealTimers();}
});
test('conditional reads acquire configured sources on demand, reuse fresh data and respect the next-sample deadline',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-19T12:00:00Z'));
 const feed=definition({sourceId:randomUUID(),pollIntervalMs:15000}),ref={sourceId:feed.sourceId,feedId:feed.feedId,configVersion:1,schemaVersion:1};
 const poll=vi.fn(async context=>{context.connected();context.emit(sample('42'));});
 const host=createDataSourceHostService([fakeHttp(poll)],[feed],{runtime:{random:()=>0.5}});
 try{
  expect(poll).not.toHaveBeenCalled();const first=host.ruleRead(ref,'latest',1000,new AbortController().signal);await vi.advanceTimersByTimeAsync(25);
  expect((await first).latest?.payload).toEqual({kind:'metric',value:'42'});expect(poll).toHaveBeenCalledTimes(1);
  expect((await host.ruleRead(ref,'latest',1000,new AbortController().signal)).quality).toBe('fresh');expect(poll).toHaveBeenCalledTimes(1);
  const next=host.ruleRead(ref,'next',100,new AbortController().signal).catch(error=>error);await vi.advanceTimersByTimeAsync(100);expect(await next).toBeInstanceOf(Error);expect(poll).toHaveBeenCalledTimes(1);
  await expect(host.ruleRead({...ref,configVersion:2},'latest',100,new AbortController().signal)).rejects.toThrow('unavailable');
 }finally{host.close();vi.useRealTimers();}
});

test('event rule consumers fan out on one transport with bounded non-destructive batches and gap invalidation',async()=>{
 vi.useFakeTimers();vi.setSystemTime(100000);
 const feed=definition({sourceId:randomUUID(),kind:'event',semantics:'event',eventFields:{id:'string',value:'number'}}),ref={sourceId:feed.sourceId,feedId:feed.feedId,configVersion:1,schemaVersion:1};
 let emit:((id:string)=>void)|undefined;
 const poll=vi.fn(async context=>{context.connected();emit=id=>context.emit({payload:{kind:'event',fields:{id,value:1}},eventTime:Date.now(),origin:'live'});await new Promise(()=>{});});
 const host=createDataSourceHostService([fakeHttp(poll)],[feed],{runtime:{limits:{eventsPerConsumer:12},random:()=>0.5}}),one=randomUUID(),two=randomUUID(),rule=randomUUID();
 try{
  host.ruleEvents(one,[{ruleId:rule,revision:1,ref}]);host.ruleEvents(two,[{ruleId:rule,revision:1,ref}]);await vi.advanceTimersByTimeAsync(0);expect(poll).toHaveBeenCalledTimes(1);
  for(let i=0;i<12;i++)emit!(String(i));
  const batch=host.ruleEventBatch(one,rule)!;expect(batch.observations).toHaveLength(8);expect(host.ruleEventBatch(one,rule)!.observations).toHaveLength(8);
  expect(batch.ack()).toBe(true);expect(batch.ack()).toBe(false);expect(host.ruleEventBatch(one,rule)!.observations).toHaveLength(4);
  expect(host.ruleEventBatch(two,rule)!.observations).toHaveLength(8);
  const rebuilt=randomUUID();host.ruleEvents(rebuilt,[{ruleId:rule,revision:1,ref}],true);
  expect(host.ruleEventBatch(rebuilt,rule)?.gap).toBe(true);expect(host.ruleEventBatch(rebuilt,rule)?.ack()).toBe(true);host.ruleEvents(rebuilt,[]);
  const before=host.ruleEventBatch(one,rule)!;emit!('overflow');expect(before.valid()).toBe(false);expect(before.ack()).toBe(false);
  const gap=host.ruleEventBatch(one,rule)!;expect(gap.gap).toBe(true);expect(gap.observations).toEqual([]);expect(gap.snapshot.issue).toBe('capacity');expect(gap.ack()).toBe(true);
  host.ruleEvents(one,[]);expect(host.ruleEventBatch(one,rule)).toBeNull();
 }finally{host.close();vi.useRealTimers();}
});
