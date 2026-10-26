import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,expect,vi} from 'vitest';
import {WorkerDatabase} from '../../../src/main/database-client';
import {migrate} from '../../../src/main/migrations';
import {createCoinbaseSourceSettings} from '../../../src/main/data-sources/coinbase-stream/source-settings';
import {createCoinbaseStreamPriceWriter} from '../../../src/main/coinbase/stream-price-store';
const summary=(values:number[])=>{const sorted=values.toSorted((a,b)=>a-b);return {count:values.length,medianMs:sorted[Math.ceil(sorted.length*.5)-1],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],maxMs:sorted.at(-1)};};
test('disk-backed portfolio and hourly history reads under 100-market stream write contention',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'earlybird-stream-contention-'));
 const db=new WorkerDatabase(join(directory,'database'));
 let writer:ReturnType<typeof createCoinbaseStreamPriceWriter>|undefined;
 try{
  await db.waitReady;await migrate(db);
  const database={use:async<T>(fn:(db:WorkerDatabase)=>Promise<T>)=>fn(db)};
  const source=await createCoinbaseSourceSettings(database).load();let now=Date.now();
  const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','synthetic-contention' FROM local_owners RETURNING id")).rows[0].id;
  const account=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number) VALUES($1,'fixture','fixture') RETURNING id",[connection])).rows[0].id;
  const payload=JSON.stringify({portfolio:{totalValue:'12345',currency:'USD'},holdings:Array.from({length:100},(_,i)=>({asset:`ASSET${i}`,quantity:'1',price:'123.45'}))});
  await db.query(`INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data)
   SELECT $1,to_timestamp($2/1000.0)-i*interval '10 minutes',$3::jsonb FROM generate_series(0,4319) i`,[account,now,payload]);
  const quotes=Array.from({length:100},(_,i)=>({product:`ASSET${i}-USD`,price:'123.45',eventTime:now}));
  const errors=vi.fn();writer=createCoinbaseStreamPriceWriter(database,()=>({revision:source.revision,quotes}),()=>now,errors);await writer.tick();
  // These are the production latest-portfolio and hourly-history SELECTs from portfolio.snapshot.
  const latest=()=>db.query('SELECT observed_at,data FROM coinbase_portfolio_observations WHERE account_id=$1 ORDER BY observed_at DESC,id DESC LIMIT 1',[account]);
  const history=()=>db.query(`SELECT DISTINCT ON (date_trunc('hour',observed_at)) observed_at,data->'portfolio'->>'totalValue' AS total_value,data->'portfolio'->>'currency' AS currency
   FROM coinbase_portfolio_observations WHERE account_id=$1 AND observed_at>=to_timestamp($2/1000.0)
   ORDER BY date_trunc('hour',observed_at),observed_at DESC,id DESC`,[account,now-366*86400000]);
  const expected=(await history()).rows;
  const baseline={portfolio:[] as number[],history:[] as number[]},contended={portfolio:[] as number[],history:[] as number[]},writes:number[]=[];
  async function sample(withWrites:boolean,record=true){
   now+=1000;quotes.forEach(q=>q.eventTime=now);
   const start=performance.now();
   const write=withWrites?writer!.tick().then(()=>{if(record)writes.push(performance.now()-start);}):Promise.resolve();
   const target=withWrites?contended:baseline;
   await Promise.all([write,...([['portfolio',latest],['history',history]] as const).map(async([key,read])=>{
    const began=performance.now(),result=await read();if(record)target[key].push(performance.now()-began);
    if(key==='portfolio')expect(result.rows).toHaveLength(1);else expect(result.rows).toEqual(expected);
   })]);
  }
  for(let i=0;i<4;i++)await sample(i%2===0,false);
  // Alternate order to avoid assigning all cache/JIT warm-up to one scenario.
  for(let i=0;i<40;i++){await sample(i%2===0);await sample(i%2!==0);}
  expect(errors).not.toHaveBeenCalled();
  expect((await db.query("SELECT pair FROM public_price_cache WHERE kind='stream-price'")).rows).toHaveLength(100);
  expect((await db.query<{count:number}>('SELECT count(*)::int AS count FROM coinbase_portfolio_observations')).rows[0].count).toBe(4320);
  const report={scenario:'Disk-backed PGlite worker; 100 markets per write; 4320 portfolio observations with 100 holdings; 40 samples per condition. Batches run back-to-back (stress, not a 1 Hz soak). Query latency includes worker queue wait; not full UI latency.',baseline:{portfolio:summary(baseline.portfolio),history:summary(baseline.history)},contended:{portfolio:summary(contended.portfolio),history:summary(contended.history)},writes:summary(writes)};
  await writeFile('/tmp/earlybird-stream-disk-contention.json',JSON.stringify(report,null,2));
  // Broad stall guard, not a hardware-specific performance promise.
  expect(Math.max(...contended.portfolio,...contended.history)).toBeLessThan(2000);
 }finally{await writer?.close();await db.close();await rm(directory,{recursive:true,force:true});}
},60000);
