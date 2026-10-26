import {writeFileSync} from 'node:fs';
import {test,expect,vi} from 'vitest';
import {WorkerDatabase} from '../../../src/main/database-client';
import {migrate} from '../../../src/main/migrations';
import {createCoinbaseSourceSettings} from '../../../src/main/data-sources/coinbase-stream/source-settings';
import {createCoinbaseStreamPriceWriter} from '../../../src/main/coinbase/stream-price-store';
test('100-market writer throughput and unchanged-tick database work',async()=>{
 const db=new WorkerDatabase();await db.waitReady;await migrate(db);
 const database={use:async<T>(fn:(db:WorkerDatabase)=>Promise<T>)=>fn(db)};
 const source=await createCoinbaseSourceSettings(database).load();let now=Date.now();
 const quotes=Array.from({length:100},(_,i)=>({product:`ASSET${i}-USD`,price:'123.456789123456789',eventTime:now}));
 const errors=vi.fn(),query=vi.spyOn(db,'query');const writer=createCoinbaseStreamPriceWriter(database,()=>({revision:source.revision,quotes}),()=>now,errors);
 try{
  await writer.tick();query.mockClear();const times:number[]=[];
  for(let i=0;i<20;i++){now+=1000;quotes.forEach(quote=>quote.eventTime=now);const start=performance.now();await writer.tick();times.push(performance.now()-start);}
  const activeQueries=query.mock.calls.length;query.mockClear();
  for(let i=0;i<10;i++)await writer.tick();
  const sorted=times.toSorted((a,b)=>a-b);
  writeFileSync('/tmp/earlybird-stream-performance.json',JSON.stringify({scenario:'100 markets, 20 updates, real DB worker, synthetic in-memory database',activeQueries,idleQueries:query.mock.calls.length,medianMs:sorted[10],p95Ms:sorted[18]}));
  expect(activeQueries).toBe(20);expect(query.mock.calls.length).toBe(0);
  expect(errors).not.toHaveBeenCalled();
  expect((await db.query("SELECT pair FROM public_price_cache WHERE kind='stream-price'")).rows).toHaveLength(100);
 }finally{await writer.close();query.mockRestore();await db.close();}
},20000);
