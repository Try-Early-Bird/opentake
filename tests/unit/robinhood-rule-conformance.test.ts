// On Robinhood: the shared adapter contract, run against the real Robinhood rule
// adapter over the real instructions, planner and executor, with the fake broker.
import {actionAdapterConformance} from './execution/action-conformance';
import {fixture} from './robinhood-rule-fixture';
import type {ActionJobs} from '../../src/main/execution/action-jobs';

actionAdapterConformance('robinhood rule rebalance',async()=>{
 const f=await fixture({approval:'within_existing_policy'});
 // Each step stands for enough time passing that held jobs are due, as in the end-to-end test.
 const jobs=():ActionJobs=>({...f.app().jobs,tick:()=>f.app().tick()});
 let current=jobs();
 const keys=new Map<string,string>();
 return {
  get jobs(){return current;},
  async enqueue(key=crypto.randomUUID()){
   if(!keys.has(key))keys.set(key,await f.fire(key));
   await f.app().trades.enqueue();
   const id=(await f.db.query<{id:string}>('SELECT id FROM action_jobs WHERE origin_id=$1',[keys.get(key)])).rows[0].id;
   return (await current.get(id))!;
  },
  broker:{
   sent:()=>f.placed().length,
   nextSubmit:mode=>{if(mode==='hang'||mode==='crash')throw Error('covered elsewhere');f.nextPlacement(mode);},
   async fill(amount){if(amount==='part')throw Error('covered elsewhere');await f.fillAll();},
  },
  // The Robinhood ledger holds a rule trade's cash in its open or unresolved legs.
  reserved:async job=>Number((await f.db.query<{reserved:string}>(`SELECT coalesce(sum(e.planned_notional),0)::text AS reserved FROM robinhood_rule_trades t
   JOIN strategy_executions e ON e.plan_id=t.transaction_id OR e.transaction_id=t.transaction_id
   WHERE t.request_id=$1 AND e.status IN ('queued','reviewed','submitting','submitted','partially_filled','placement_unknown','reconciliation_required')`,[job.originId])).rows[0].reserved),
  restart:async()=>{f.restart();current=jobs();return current;},
  close:async()=>{},
 };
},{
 crash:'executor/recovery tests: an intent interrupted mid-placement becomes placement_unknown and is matched on sync, never resent',
 hang:'order writer: a placement that never answers is placement_unknown, never resent (executor and writer tests)',
 partialCancel:'orders already placed run on after cancel (robinhood-rule-trades "cancel once executing"); partial fills are the executor\'s (share-events tests)',
});
