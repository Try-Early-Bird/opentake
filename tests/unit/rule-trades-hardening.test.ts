// Synthetic dependencies only; no live profile, broker or credentials.
import {expect,test,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRuleTrades} from '../../src/main/strategies/rule-trades';
import {createExecutionLoops,type ExecutionReport} from '../../src/main/execution-loops';
import {createRunCapabilities} from '../../src/main/run-capabilities';
import {hostCall,startHostRpc} from '../../src/main/host-rpc';
import {callOpentakeTool} from '../../src/main/opentake-mcp/server';
import {toolCatalog} from '../../src/main/opentake-mcp/catalog';

const unused=async():Promise<never>=>{throw Error('not reached');};
const failingWorker=(report?:(error:unknown)=>void)=>createRuleTrades({use:async()=>{throw Error('synthetic database failure');}},{enabled:()=>true,snapshot:unused,preview:unused,view:unused,confirm:unused,submit:unused,refresh:unused,cancelPrepared:unused,...(report?{report}:{})});

test('rule trade tick failures are reported, not thrown into the execution loop',async()=>{
 const reported:unknown[]=[];
 await expect(failingWorker(error=>reported.push(error)).tick()).resolves.toBeUndefined();
 expect(reported).toHaveLength(1);
 await expect(failingWorker().tick()).rejects.toThrow('synthetic database failure');
});

const loopWorkers=(failing:string[]=[],hang:string[]=[])=>{
 const ran:string[]=[],reports:ExecutionReport[]=[];
 const tick=(name:string)=>({tick:async(signal?:AbortSignal)=>{ran.push(name);if(hang.includes(name))await new Promise((_,reject)=>signal?.addEventListener('abort',()=>reject(signal.reason)));if(failing.includes(name))throw Error(`synthetic ${name} failure`);}});
 return {ran,reports,workers:{shareEvents:{check:async()=>{ran.push('share_events');if(failing.includes('share_events'))throw Error('synthetic share_events failure');}},
  robinhoodScheduler:tick('robinhood'),coinbaseScheduler:tick('coinbase'),ruleTrades:tick('rule_trades'),mixedWithdrawals:tick('mixed_withdrawals'),mixedInvestments:tick('mixed_investments')}};
};
test('a failing rule-trade run is reported and the schedulers still run',async()=>{
 const f=loopWorkers(['rule_trades']),loops=createExecutionLoops(f.workers,{ready:()=>true,report:r=>f.reports.push(r)});
 await Promise.all(loops.loops.map(l=>l.runNow()));
 expect(f.ran).toEqual(expect.arrayContaining(['rule_trades','coinbase','share_events','robinhood','mixed_withdrawals','mixed_investments']));
 expect(f.reports).toMatchObject([{event:'failed',venue:'coinbase',stage:'rule_trades',error:expect.objectContaining({message:'synthetic rule_trades failure'})}]);
 await loops.close();
});
test('every worker is isolated: a failure in one never skips another worker or venue',async()=>{
 const f=loopWorkers(['share_events','mixed_withdrawals','robinhood','coinbase']),loops=createExecutionLoops(f.workers,{ready:()=>true,report:r=>f.reports.push(r)});
 await Promise.all(loops.loops.map(l=>l.runNow()));
 // A failed mixed withdrawal skips only its paired investment tick, as before.
 expect([...f.ran].sort()).toEqual(['coinbase','mixed_withdrawals','robinhood','rule_trades','share_events']);
 expect(f.reports.map(r=>r.event==='failed'?`${r.venue}:${r.stage}`:r.kind).sort()).toEqual(['coinbase:execution','mixed:investment','robinhood:execution','robinhood:share_events']);
 await loops.close();
});
test('a hung worker times out on its own deadline while other loops keep running',async()=>{
 vi.useFakeTimers();try{
  const f=loopWorkers([],['robinhood']),loops=createExecutionLoops(f.workers,{ready:()=>true,report:r=>f.reports.push(r)});
  loops.start();await vi.advanceTimersByTimeAsync(60_000);
  expect(f.ran.filter(n=>n==='rule_trades').length).toBeGreaterThanOrEqual(10);expect(f.ran.filter(n=>n==='coinbase').length).toBeGreaterThanOrEqual(3);
  expect(f.ran.filter(n=>n==='robinhood')).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(600_000);expect(f.reports).toContainEqual({event:'loop',worker:'robinhood-scheduler',kind:'timed_out',deadlineMs:600_000});
  await vi.advanceTimersByTimeAsync(30_000);expect(f.ran.filter(n=>n==='robinhood').length).toBeGreaterThanOrEqual(2);
  expect(await loops.close()).toBe(true);
 }finally{vi.useRealTimers();}
});
test('rule trades wait while their readiness check is false; other loops are unaffected',async()=>{
 const f=loopWorkers(),loops=createExecutionLoops(f.workers,{ready:()=>true,ruleTradesReady:()=>false,report:r=>f.reports.push(r)});
 await Promise.all(loops.loops.map(l=>l.runNow()));
 expect(f.ran).not.toContain('rule_trades');expect(f.ran).toContain('coinbase');expect(f.reports).toEqual([]);
 await loops.close();
});

const manualExecution=['orders:execute','strategies:submit-coinbase-orders','strategies:confirm-coinbase-orders','strategies:preview-coinbase-orders','strategies:cancel-coinbase-orders'];
test('agent run capabilities cannot reach manual order execution paths',async()=>{
 const profile=await mkdtemp(join(tmpdir(),'earlybird-h19-'));
 const run=randomUUID(),grants=createRunCapabilities(id=>id===run,()=>0),grant=grants.issue(run,randomUUID()),seen:string[]=[];
 const host=await startHostRpc(profile,'test-build',async method=>{seen.push(method);return [];},grants.authorize);
 try{
  const scoped={...host.manifest,token:grant.token};
  for(const method of manualExecution)await expect(hostCall(scoped,method,[randomUUID()],randomUUID())).rejects.toThrow();
  expect(seen.filter(m=>manualExecution.includes(m))).toEqual([]);
 }finally{await host.close();await rm(profile,{recursive:true,force:true});}
});
test('agent tools expose no submit, confirm or execute tool',async()=>{
 const names=[...toolCatalog(false),...toolCatalog(true)].map(t=>t.name);
 expect(names.filter(n=>/submit|execute|confirm|place|cancel|create_order|order_create/i.test(n))).toEqual([]);
 const calls:string[]=[];
 const services={status:async()=>{calls.push('status');throw Error('unused');},read:async()=>{calls.push('read');throw Error('unused');}};
 for(const name of [...manualExecution,'opentake_submit_coinbase_orders','coinbase_create_order']){
  const result=await callOpentakeTool(services,name,{reviewId:randomUUID()});
  expect(result.isError).toBe(true);
 }
 expect(calls).toEqual([]);
});
