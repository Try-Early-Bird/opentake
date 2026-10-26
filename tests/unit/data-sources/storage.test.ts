import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, prepareRestoredDatabase } from '../../../src/main/migrations';
import { createSourceRepository } from '../../../src/main/data-sources/repository';
import { createObservationStorage } from '../../../src/main/data-sources/storage';
import { sourceConfigSchema } from '../../../src/main/data-sources/config';
import type { DataObservation } from '../../../src/shared/data-sources';

const config = (mode = 'history') => ({ name: 'Synthetic score', endpoint: 'https://example.com/score', collection: 'automatic', pollIntervalMs: 15_000,
  feeds: [{ id: 'score', name: 'Score', unit: 'points', mapping: { kind: 'event', fields: { score: {path: ['score'], type: 'number'}, private: {path: ['private'], type: 'string'} } },
    storage: { mode, fields: ['score'], sampleEveryMs: 1000, retentionDays: 1 } }] });

test('configuration is bounded, revisioned, optimistic, disabled on edits and untrusted after restore', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const repo = createSourceRepository({ use: work => work(db) });
    const owner = (await db.query<{id: string}>('SELECT id FROM local_owners')).rows[0].id;
    const source = await repo.save(owner, config());
    await expect(repo.enable(owner, source.id, 1, true)).rejects.toThrow('validation');
    await repo.validate(owner, source.id, 1); await repo.enable(owner, source.id, 1, true);
    const edited = await repo.save(owner, {...config(), name: 'Revised'}, {id: source.id, revision: 1});
    expect(edited).toMatchObject({revision: 2, enabled: false, validated: false});
    await expect(repo.save(owner, config(), {id: source.id, revision: 1})).rejects.toThrow('changed');
    await expect(repo.validate(owner, source.id, 1)).rejects.toThrow('changed');
    await expect(repo.enable(randomUUID(), source.id, 2, false)).rejects.toThrow();
    expect((await db.query('SELECT * FROM data_source_revisions')).rows).toHaveLength(2);
    await repo.validate(owner, source.id, 2); await repo.enable(owner, source.id, 2, true);
    await prepareRestoredDatabase(db);
    expect((await repo.list(owner))[0]).toMatchObject({ revision: 2, enabled: false, validated: false });
    expect(sourceConfigSchema.safeParse({...config(), endpoint:'https://user:secret@example.com/'}).success).toBe(false);
    expect(sourceConfigSchema.safeParse({...config(), endpoint:'https://example.com/?token=secret'}).success).toBe(false);
    expect(sourceConfigSchema.safeParse({...config(), feeds:[{...config().feeds[0], storage:{...config().feeds[0].storage, fields:['undeclared']}}]}).success).toBe(false);
    for (let i=1; i<20; i++) await repo.save(owner, config());
    await expect(repo.save(owner, config())).rejects.toThrow('limit');
  } finally { await db.close(); }
});

test('storage honors selected fields, live/latest/history, sample intervals, caps, expiry and disable fences', async () => {
  const db = new PGlite(); let now = Date.parse('2026-10-16T12:00:00Z');
  const database = {use: <T>(work: (db: PGlite) => Promise<T>) => work(db)};
  const storage = createObservationStorage(database, { now: () => now, historyCap: 2, automatic: false });
  try {
    await migrate(db);
    const repo = createSourceRepository(database), owner = (await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
    const source = await repo.save(owner, config()); await repo.validate(owner, source.id, 1); await repo.enable(owner, source.id, 1, true);
    const observation = (overrides: Partial<DataObservation> = {}): DataObservation => ({ sourceId: source.id, configVersion: 1, schemaVersion: 1, feedId: 'score', adapterId: 'custom-http', adapterVersion: '1', epoch: 1, unit: 'points', eventTime: now, receivedAt: now, timeBasis: 'provider', clockSkewMs: 0, origin: 'live', payload: {kind:'event', fields:{score:42,private:'do-not-retain'}}, ...overrides });
    const record = async (overrides: Partial<DataObservation> = {}) => { expect(storage.enqueue(owner, observation(overrides))).toBe(true); await storage.flush(); };
    await record(); now += 500; await record();
    expect((await storage.read(owner, source.id, 'score', true)).samples).toHaveLength(1);
    now += 500; await record(); now += 1000; await record();
    const history = await storage.read(owner, source.id, 'score', true);
    expect(history).toMatchObject({quality:'stale'}); expect(history.samples).toHaveLength(2);
    expect(history.samples[0].data.fields).toEqual({score:42}); expect(JSON.stringify(history)).not.toContain('do-not-retain');
    expect((await storage.read(randomUUID(), source.id, 'score', true)).samples).toEqual([]);
    expect(storage.enqueue(owner, observation({origin:'backfill'}))).toBe(false);
    expect(storage.enqueue(owner, observation({eventTime:now+6000}))).toBe(false);
    const firstLatest = (await storage.read(owner, source.id, 'score')).samples[0].receivedAt;
    now += 5000; await record(); expect((await storage.read(owner, source.id, 'score')).samples[0].receivedAt).not.toBe(firstLatest);
    now += 5000; storage.enqueue(owner, observation()); await repo.enable(owner, source.id, 1, false); await storage.flush();
    expect((await storage.read(owner, source.id, 'score')).samples[0].receivedAt).not.toBe(new Date(now).toISOString());
    const latest = await repo.save(owner, config('latest'), {id:source.id,revision:1});
    await repo.validate(owner, source.id, latest.revision); await repo.enable(owner, source.id, latest.revision, true);
    await record({configVersion:2}); expect((await storage.read(owner, source.id, 'score', true)).samples).toEqual([]);
    expect((await storage.read(owner, source.id, 'score')).samples).toHaveLength(1);
    const live = await repo.save(owner, config('live'), {id:source.id,revision:2});
    await repo.validate(owner, source.id, live.revision); await repo.enable(owner, source.id, live.revision, true);
    now += 5000; await record({configVersion:3}); expect((await storage.read(owner, source.id, 'score')).samples).toEqual([]);
    now += 2*86_400_000; await storage.flush(); expect((await db.query('SELECT id FROM data_source_history')).rows).toEqual([]);
    await storage.close(); expect(storage.enqueue(owner, observation())).toBe(false);
  } finally { await storage.close(); await db.close(); }
});

test('failed storage commits retain queued observations for retry and backpressure new arrivals',async()=>{
 const db=new PGlite();await migrate(db);let fail=false;
 const database={use:async<T>(work:(db:PGlite)=>Promise<T>)=>{if(fail)throw Error('fixture failure');return work(db);}};
 const repo=createSourceRepository(database),owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
 const source=await repo.save(owner,config('latest'));await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);
 const now=Date.now(),storage=createObservationStorage(database,{automatic:false,now:()=>now});
 const observation:DataObservation={sourceId:source.id,feedId:'score',configVersion:1,schemaVersion:1,adapterId:'custom-http',adapterVersion:'1',epoch:1,unit:'points',eventTime:now,receivedAt:now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields:{score:7,private:'fixture'}}};
 try{
  expect(storage.enqueue(owner,observation)).toBe(true);fail=true;await expect(storage.flush()).rejects.toThrow('unavailable');
  expect(storage.status()).toEqual({pending:1,failed:true});expect(storage.enqueue(owner,observation)).toBe(false);
  fail=false;await storage.flush();expect(storage.status()).toEqual({pending:0,failed:false});
  expect((await db.query('SELECT * FROM data_source_latest')).rows).toHaveLength(1);
 }finally{fail=false;await storage.close();await db.close();}
});

test('the history cap holds within one batch using one owner count, not one count per insert',async()=>{
 const db=new PGlite();await migrate(db);let now=Date.parse('2026-10-16T12:00:00Z');
 const counts:string[]=[];
 const database={use:<T>(work:(db:PGlite)=>Promise<T>)=>work(new Proxy(db,{get(target,key){
  const value=Reflect.get(target,key);
  if(key!=='transaction')return typeof value==='function'?value.bind(target):value;
  return (fn:(tx:PGlite)=>Promise<unknown>)=>target.transaction(tx=>fn(new Proxy(tx,{get(inner,name){const v=Reflect.get(inner,name);return name==='query'?(sql:string,params?:unknown[])=>{if(/count\(\*\)/.test(sql))counts.push(sql);return (v as Function).call(inner,sql,params);}:typeof v==='function'?v.bind(inner):v;}}) as PGlite));
 }}) as PGlite)};
 const repo=createSourceRepository(database),owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
 const source=await repo.save(owner,config());await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);
 const storage=createObservationStorage(database,{now:()=>now,historyCap:3,automatic:false});
 try{
  for(let i=0;i<6;i++){now+=1000;expect(storage.enqueue(owner,{sourceId:source.id,feedId:'score',configVersion:1,schemaVersion:1,adapterId:'custom-http',adapterVersion:'1',epoch:1,unit:'points',eventTime:now,receivedAt:now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields:{score:i,private:'x'}}})).toBe(true);}
  await storage.flush();
  expect((await db.query('SELECT id FROM data_source_history')).rows).toHaveLength(3);
  expect(counts.filter(sql=>sql.includes('data_source_history'))).toHaveLength(1);
  expect((await storage.read(owner,source.id,'score',true)).samples.map(sample=>sample.data.fields.score)).toEqual([5,4,3]);
 }finally{await storage.close();await db.close();}
});

test('flush resolves only after the batch holding observations enqueued during an in-flight batch commits',async()=>{
 const db=new PGlite();await migrate(db);let gate:Promise<void>|undefined,open!:()=>void;
 const database={use:async<T>(work:(db:PGlite)=>Promise<T>)=>{const wait=gate;gate=undefined;await wait;return work(db);}};
 const repo=createSourceRepository(database),owner=(await db.query<{id:string}>('SELECT id FROM local_owners')).rows[0].id;
 const source=await repo.save(owner,config());await repo.validate(owner,source.id,1);await repo.enable(owner,source.id,1,true);
 let now=Date.now();const storage=createObservationStorage(database,{automatic:false,now:()=>now});
 const observation=(score:number):DataObservation=>({sourceId:source.id,feedId:'score',configVersion:1,schemaVersion:1,adapterId:'custom-http',adapterVersion:'1',epoch:1,unit:'points',eventTime:now,receivedAt:now,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'event',fields:{score,private:'fixture'}}});
 try{
  gate=new Promise(resolve=>{open=resolve;});
  expect(storage.enqueue(owner,observation(1))).toBe(true);const first=storage.flush();
  // Metadata accept(): a newer observation arrives while the first batch is still in flight.
  now+=2000;expect(storage.enqueue(owner,observation(2))).toBe(true);const second=storage.flush();
  open();await second;
  expect(storage.status()).toEqual({pending:0,failed:false});
  expect((await storage.read(owner,source.id,'score',true)).samples.map(sample=>sample.data.fields.score)).toEqual([2,1]);
  await first;
 }finally{await storage.close();await db.close();}
});
