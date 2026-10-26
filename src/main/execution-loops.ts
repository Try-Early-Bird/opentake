import {createWorkerLoop,type WorkerEvent,type WorkerLoop} from './execution/worker-loop';

// Strategy execution as independent loops instead of one 30 s
// pass. A slow or failing worker no longer delays the others, each loop has its
// own interval and deadline, and events wake a loop early. Money-moving work on
// one account is kept apart by the account queues, not by running in sequence.
// - Rule trades: 5 s backup; woken when a rule fires or orders are sent.
// - Mixed Takes: 10 s; withdrawals, then investments.
// - Coinbase scheduler: 15 s; woken when a sync saves balances or orders are sent.
// - Robinhood scheduler: 30 s; share events are checked first because planning
//   holds symbols whose split is unconfirmed (the check works once a day).

type Tick={tick(signal?:AbortSignal):Promise<unknown>};
export interface ExecutionWorkers{
 shareEvents:{check():Promise<unknown>};
 robinhoodScheduler:Tick;
 coinbaseScheduler:Tick;
 ruleTrades:Tick;
 mixedWithdrawals:Tick;
 mixedInvestments:Tick;
}
export type ExecutionReport=
 |{event:'failed';venue?:'robinhood'|'coinbase'|'mixed';stage:string;error?:unknown}
 |{event:'loop';worker:string;kind:WorkerEvent['kind'];durationMs?:number;deadlineMs?:number;heldMs?:number};
export interface ExecutionLoopOptions{
 /** Trading on, app idle enough to trade: settings not busy, not quitting, not suspended. */
 ready:()=>boolean;
 /** Extra readiness for rule trades (e.g. no Coinbase investment preparing). */
 ruleTradesReady?:()=>boolean;
 coinbaseSchedulerReady?:()=>boolean;
 report:(report:ExecutionReport)=>void;
 /** After each Robinhood run (venue queue statistics). */
 afterRobinhood?:()=>void;
 intervals?:Partial<Record<'rule-trades'|'mixed'|'coinbase-scheduler'|'robinhood-scheduler',number>>;
 /** Starts each run outside any caller's account hold or member priority. */
 isolate?:<T>(work:()=>T)=>T;
}

export function createExecutionLoops(workers:ExecutionWorkers,options:ExecutionLoopOptions){
 const step=async(venue:'robinhood'|'coinbase'|'mixed',stage:string,run:()=>Promise<unknown>)=>{
  try{await run();}catch(error){options.report({event:'failed',venue,stage,error});}
 };
 const loop=(name:'rule-trades'|'mixed'|'coinbase-scheduler'|'robinhood-scheduler',intervalMs:number,deadlineMs:number,run:(signal:AbortSignal)=>Promise<unknown>,ready=options.ready)=>createWorkerLoop({
  name,intervalMs:options.intervals?.[name]??intervalMs,deadlineMs,run,enabled:ready,isolate:options.isolate,
  report:event=>{
   if(event.kind==='failed'){options.report({event:'failed',venue:name==='mixed'?'mixed':name==='robinhood-scheduler'?'robinhood':'coinbase',stage:name==='rule-trades'?'rule_trades':'execution',error:event.error});return;}
   options.report({event:'loop',worker:name,kind:event.kind,...('durationMs' in event?{durationMs:event.durationMs}:{}),...('deadlineMs' in event?{deadlineMs:event.deadlineMs}:{}),...('heldMs' in event?{heldMs:event.heldMs}:{})});
  },
 });
 const ruleTrades=loop('rule-trades',5_000,120_000,signal=>workers.ruleTrades.tick(signal),()=>options.ready()&&(options.ruleTradesReady?.()??true));
 const mixed=loop('mixed',10_000,300_000,async()=>{
  // A failed withdrawal skips only the paired investment tick of this run, as before.
  await step('mixed','investment',async()=>{await workers.mixedWithdrawals.tick();await workers.mixedInvestments.tick();});
 });
 const coinbaseScheduler=loop('coinbase-scheduler',15_000,300_000,signal=>workers.coinbaseScheduler.tick(signal),()=>options.ready()&&(options.coinbaseSchedulerReady?.()??true));
 const robinhoodScheduler=loop('robinhood-scheduler',30_000,600_000,async signal=>{
  await step('robinhood','share_events',()=>workers.shareEvents.check());
  if(!signal.aborted)await workers.robinhoodScheduler.tick(signal);
  options.afterRobinhood?.();
 });
 const loops:WorkerLoop[]=[ruleTrades,mixed,coinbaseScheduler,robinhoodScheduler];
 return {
  ruleTrades,mixed,coinbaseScheduler,robinhoodScheduler,loops,
  start(){for(const l of loops)l.start();},
  suspend(){for(const l of loops)l.suspend();},
  resume(){for(const l of loops)l.resume();},
  running:()=>loops.some(l=>l.running()),
  stats:()=>Object.fromEntries(loops.map(l=>[l.name,l.stats()])),
  /** Wait at most `deadlineMs` in total for every loop to stop. */
  async close(deadlineMs=5_000){return (await Promise.all(loops.map(l=>l.close(deadlineMs)))).every(Boolean);},
 };
}
export type ExecutionLoops=ReturnType<typeof createExecutionLoops>;
