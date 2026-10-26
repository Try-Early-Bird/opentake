import {expect,test} from 'vitest';
import {writeFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {gzipSync} from 'node:zlib';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {createFixture} from './fixture';
import {createServices} from './services';
import {readWindow} from './latency-runner';
import {createCoinbaseStreamPriceWriter} from '../../src/main/coinbase/stream-price-store';
import {createCoinbaseSourceSettings} from '../../src/main/data-sources/coinbase-stream/source-settings';
import {syncCoinbaseLifecycleNotifications} from '../../src/main/coinbase/lifecycle-notifications';
import {syncActionNotifications} from '../../src/main/action-notifications';

test.skipIf(process.env.EARLYBIRD_PERF_STREAM_CONTENTION!=='1')('measure disk-backed foreground reads with 100-market stream writes',async()=>{
 const output=process.env.EARLYBIRD_PERF_OUTPUT;
 if(!output||!isAbsolute(output)||!process.versions.node.startsWith('24.'))throw Error('Use Node 24 and an absolute output directory');
 const results=[];
 for(const size of [
  {name:'500-takes-10k-history',accountsPerVenue:25,allocationsPerAccount:10,historyRows:10_000},
  {name:'100-takes-100k-history',accountsPerVenue:5,allocationsPerAccount:10,historyRows:100_000},
 ])for(let repetition=1;repetition<=3;repetition++){
  const f=await createFixture({...size,seed:'baseline-v1'}),s=createServices(f);
  let writer:ReturnType<typeof createCoinbaseStreamPriceWriter>|undefined;
  try{
   const source=await createCoinbaseSourceSettings(f.database).load();
   let quoteTime=f.clock(),updates=0;const errors:unknown[]=[];
   const quotes=Array.from({length:100},(_,i)=>({product:`ASSET${i}-USD`,price:'123.456789123456789',eventTime:quoteTime}));
   writer=createCoinbaseStreamPriceWriter(f.database,()=>({revision:source.revision,quotes}),()=>quoteTime,()=>{errors.push('stream write failed');});
   const reconcile=async()=>{await syncCoinbaseLifecycleNotifications(f.db,f.clock());await syncActionNotifications(f.db,f.clock());};
   await reconcile();await writer.tick();await readWindow(f,s,'warm',2);
   const phases=[];
   for(const phase of ['idle-before','stream','reconciliation','combined','idle-after']){
    const stream=phase==='stream'||phase==='combined',busy=phase==='reconciliation'||phase==='combined';
    const writes:number[]=[],passes:number[]=[];
    f.measurement.samples.length=0;f.measurement.queries.clear();
    const result=await readWindow(f,s,phase,120,stream||busy?async collecting=>{
     await Promise.all([
      stream?(async()=>{while(collecting()){
       quoteTime+=1000;updates++;quotes.forEach(q=>{q.eventTime=quoteTime;q.price=String(123+(updates%2));});
       const start=performance.now();await f.measurement.scope('stream-write',()=>writer!.tick());writes.push(performance.now()-start);
       await delay(Math.max(0,1000-(performance.now()-start)));
      }})():Promise.resolve(),
      busy?(async()=>{while(collecting()){const start=performance.now();await f.measurement.scope('reconciliation',reconcile);passes.push(performance.now()-start);}})():Promise.resolve(),
     ]);
    }:undefined);
    expect(result.completed).toBe(120);expect(result.probes.every(p=>p.outcome==='ok')).toBe(true);
    if(stream)expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(errors).toEqual([]);
    expect((await f.db.query("SELECT pair FROM public_price_cache WHERE kind='stream-price'")).rows).toHaveLength(100);
    phases.push({...result,writes,passes});
    await writeFile(join(output,`${size.name}-r${repetition}-${phase}.json.gz`),gzipSync(JSON.stringify({samples:f.measurement.samples,queries:Object.fromEntries(f.measurement.queries)})));
   }
   expect(f.measurement.failures).toEqual([]);expect(s.unexpectedCalls).toEqual([]);
   results.push({key:`${size.name}-r${repetition}`,fixture:f.manifest,phases});
   await writeFile(join(output,'stream-contention-run.json'),JSON.stringify({node:process.version,markets:100,streamCadenceMs:1000,samplesPerProbePerPhase:120,results},null,2));
   console.log(`Completed ${size.name}-r${repetition}`);
  }finally{await writer?.close();await s.stop();await s.portfolio.close();await f.close();}
 }
},600_000);
