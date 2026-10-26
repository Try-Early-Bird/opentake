import {expect,test} from 'vitest';
import {performance} from 'node:perf_hooks';
import {writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {createFixture} from './fixture';
import {createServices,type FakeBehavior} from './services';
import {readWindow} from './latency-runner';

test.skipIf(process.env.EARLYBIRD_PERF_SCHEDULER!=='1')('measure provider delay, failure isolation and two-pass scheduler coverage',async()=>{
 const output=process.env.EARLYBIRD_PERF_OUTPUT;
 if(!output||!isAbsolute(output)||!process.versions.node.startsWith('24.'))throw Error('Use Node 24 and an absolute output directory');
 const results=[];
 const scenarios:{name:string;behavior:FakeBehavior}[]=[
  {name:'control',behavior:{}},
  {name:'slow-robinhood',behavior:{slowCall:1,slowMs:3000}},
  {name:'slow-coinbase',behavior:{slowCall:51,slowMs:3000}},
  {name:'failed-robinhood',behavior:{rejectCall:1}},
 ];
 for(const scenario of scenarios)for(let repetition=1;repetition<=3;repetition++){
  const f=await createFixture({seed:'baseline-v1',accountsPerVenue:6,allocationsPerAccount:10,historyRows:1000});
  const s=createServices(f,scenario.behavior);
  try{
   await readWindow(f,s,'warm',2);
   const passes:{pass:number;venue:string;startedMs:number;durationMs:number;calls:number}[]=[];
   const start=performance.now();
   const foreground=await readWindow(f,s,'scheduler',120,async()=>{
    for(let pass=1;pass<=2;pass++)for(const [venue,scheduler] of [['robinhood',s.robinhood],['coinbase',s.coinbase]] as const){
     const before=s.calls.length,at=performance.now();
     const job=scheduler.tick();
     expect(scheduler.tick()).toBe(job); // No overlapping duplicate pass.
     await job;
     passes.push({pass,venue,startedMs:at-start,durationMs:performance.now()-at,calls:s.calls.length-before});
    }
   });
   const coverage=Object.fromEntries(['robinhood','coinbase'].map(venue=>[venue,new Set(s.calls.filter(c=>c.venue===venue).map(c=>c.id)).size]));
   expect(coverage).toEqual({robinhood:60,coinbase:60});
   expect(passes.map(p=>p.calls)).toEqual([50,60,50,0]);
   expect(foreground.completed).toBe(120);expect(foreground.probes.every(p=>p.outcome==='ok')).toBe(true);
   const failed=s.calls.filter(c=>c.outcome==='error');
   expect(failed).toHaveLength(scenario.name==='failed-robinhood'?1:0);
   if(failed.length){
    const row=(await f.db.query<{planning_failures:number;deferred:boolean}>('SELECT planning_failures,planning_deferred_until>$2::timestamptz AS deferred FROM strategy_allocations WHERE id=$1',[failed[0].id,new Date(f.clock()).toISOString()])).rows[0];
    expect(row).toEqual({planning_failures:1,deferred:true});
   }
   expect(s.unexpectedCalls).toEqual([]);expect(f.measurement.failures).toEqual([]);
   results.push({scenario:scenario.name,repetition,fixture:f.manifest,passes,coverage,foreground,calls:s.calls.map(c=>({...c,startedMs:c.startedMs-start}))});
   await writeFile(join(output,'scheduler-run.json'),JSON.stringify({node:process.version,electron:process.versions.electron,delayMs:3000,results},null,2));
  }finally{await s.stop();await s.portfolio.close();await f.close();}
 }
},300000);
