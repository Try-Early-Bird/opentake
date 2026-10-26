import { test,expect,vi,afterEach } from 'vitest';
import { createRunBudget } from '../../../src/main/run-budget';
afterEach(()=>vi.useRealTimers());
test('approval waits pause inference time but overlapping waits do not double extend it',()=>{
 vi.useFakeTimers();const budget=createRunBudget(new AbortController().signal,{inferenceMs:100,absoluteMs:1000});
 vi.advanceTimersByTime(60);const a=budget.pause();const b=budget.pause();vi.advanceTimersByTime(300);a();vi.advanceTimersByTime(200);expect(budget.signal.aborted).toBe(false);b();vi.advanceTimersByTime(39);expect(budget.signal.aborted).toBe(false);vi.advanceTimersByTime(1);expect(budget.signal.reason.message).toContain('inference');budget.finish();expect(vi.getTimerCount()).toBe(0);
});
test('absolute deadlines and user cancellation still stop a paused run',()=>{
 vi.useFakeTimers();const parent=new AbortController();const budget=createRunBudget(parent.signal,{inferenceMs:100,absoluteMs:500});budget.pause();vi.advanceTimersByTime(500);expect(budget.signal.reason.message).toContain('overall');budget.finish();
 const second=createRunBudget(parent.signal);second.pause();parent.abort();expect(second.signal.aborted).toBe(true);second.finish();expect(vi.getTimerCount()).toBe(0);
});

test('tool dispatch budget permits thirty attempts then aborts even if attempts failed',()=>{
 const budget=createRunBudget(new AbortController().signal);
 try{for(let i=0;i<30;i++)budget.toolDispatch();expect(budget.signal.aborted).toBe(false);expect(()=>budget.toolDispatch()).toThrow('30 tool-call');expect(budget.signal.aborted).toBe(true);expect(()=>budget.toolDispatch()).toThrow('30 tool-call');}finally{budget.finish();}
});

test('ending an adapter aborts pending tool work without cancelling the parent take',()=>{
 const parent=new AbortController(),budget=createRunBudget(parent.signal);budget.cancel();
 expect(budget.signal.aborted).toBe(true);expect(parent.signal.aborted).toBe(false);expect(()=>budget.toolDispatch()).toThrow('Response ended');budget.finish();
});

test('a rule run sets its own tool-call limit',()=>{
 const budget=createRunBudget(new AbortController().signal,{inferenceMs:1000,absoluteMs:1000,toolCalls:2});
 budget.toolDispatch();budget.toolDispatch();expect(()=>budget.toolDispatch()).toThrow('2 tool-call limit');budget.finish();
});
