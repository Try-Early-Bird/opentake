import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createMixedPreviewStore} from '../../src/main/mixed-execution/store';
import type {MixedPreview} from '../../src/shared/mixed-execution';
test('mixed preview journal survives service recreation and rejects conflicting retries without funding',async()=>{
 const db=new PGlite();try{
  await migrate(db);
  const take=randomUUID(),strategy=randomUUID(),version=randomUUID();
  await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
  await db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners`,[version,strategy]);
  await db.query(`INSERT INTO takes(id,owner_id,title,selection,strategy_id) SELECT $1,id,'Synthetic','{}',$2 FROM local_owners`,[take,strategy]);
  const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
  const store=createMixedPreviewStore(database),operation=randomUUID();
  const preview:MixedPreview={id:randomUUID(),takeId:take,versionId:version,routeRevision:randomUUID(),amountUsd:'100',state:'blocked',expiresAt:'2026-10-13T13:00:00Z',legs:[],executionEnabled:false};
  const [first,second]=await Promise.all([store.save(operation,'same',preview),store.save(operation,'same',{...preview,id:randomUUID()})]);
  expect(first.id).toBe(second.id);
  expect(await createMixedPreviewStore(database).find(operation)).toEqual({requestHash:'same',preview:first});
  await expect(store.save(operation,'different',preview)).rejects.toThrow('Operation ID');
  expect((await db.query('SELECT * FROM strategy_allocations')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM coinbase_allocations')).rows).toHaveLength(0);
  expect((await db.query('SELECT * FROM strategy_executions')).rows).toHaveLength(0);
 }finally{await db.close();}
});
