import {test,expect,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {createSourceRepository} from '../../../src/main/data-sources/repository';
import {createCustomDataSources} from '../../../src/main/data-sources/service';

test('conditional HTTP metadata fetch returns committed field evidence and stops on cancellation',async()=>{
 const db=new PGlite();await migrate(db);const database={use:async<T>(work:(db:any)=>Promise<T>)=>work(db)};
 const secrets={available:()=>false,get:async()=>{throw Error('No secrets');},set:async()=>{throw Error();},delete:async()=>{throw Error();},has:async()=>false};
 const read=vi.fn(async()=>({score:7})),service=createCustomDataSources(database,secrets,{read});
 try{
  const owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id,repo=createSourceRepository(database);
  const source=await repo.save(owner,{name:'Metadata',endpoint:'https://fixture.example/data',collection:'when-open',feeds:[{id:'metadata',name:'Score',unit:'points',mapping:{kind:'event',fields:{score:{path:['score'],type:'number'}}},storage:{mode:'latest',fields:['score']},destination:{kind:'market-metadata',market:{venue:'robinhood',instance:'production',kind:'equity',reference:'AAPL'},namespace:'sentiment',maxAgeMs:60000}}]});
  await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);await service.start();
  const binding={key:'score',sourceId:source.id,sourceRevision:1,feedId:'metadata',field:'score',kind:'event' as const,unit:'points',maxAgeMs:15000};
  const result=await service.ruleFetch(binding,'latest',5000,new AbortController().signal);
  expect(result).toMatchObject({quality:'fresh',value:7});expect(result.observation?.runtimeId).toBeTruthy();
  expect((await db.query<{fields:{score:number}}>('SELECT fields FROM market_source_metadata')).rows[0].fields.score).toBe(7);
  const abort=new AbortController();abort.abort();await expect(service.ruleFetch(binding,'next',100,abort.signal)).rejects.toThrow('unavailable');
  await expect(service.ruleFetch(binding,'next',100,new AbortController().signal)).rejects.toThrow('unavailable');
  expect(read).toHaveBeenCalledTimes(1);
 }finally{await service.close();await db.close();}
});
