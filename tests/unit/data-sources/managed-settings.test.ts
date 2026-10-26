import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {createManagedSourceSettings} from '../../../src/main/data-sources/managed-settings';
test('managed settings persist per job, reject stale saves and enforce valid intervals without touching account data',async()=>{
 const db=new PGlite();
 try{
  await migrate(db);const database={use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)};
  const settings=createManagedSourceSettings(database), defaults=await settings.list();
  expect(defaults).toHaveLength(4);expect(defaults.every(item=>item.revision===0&&item.collection==='automatic')).toBe(true);
  const price=defaults.find(item=>item.id==='robinhood-prices')!;
  const saved=await settings.save({...price,collection:'off',intervalMs:60000});
  expect(saved.revision).toBe(1);
  expect((await createManagedSourceSettings(database).list()).find(item=>item.id===price.id)).toEqual(saved);
  await expect(settings.save(price)).rejects.toThrow('changed');
  for(const patch of [{intervalMs:5000},{intervalMs:86400001},{id:'unknown'},{collection:'invalid'},{ownerId:'spoof'}])await expect(settings.save({...saved,...patch})).rejects.toThrow();
  const results=await Promise.allSettled([settings.save({...saved,collection:'automatic'}),settings.save({...saved,intervalMs:300000})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  expect((await settings.list()).filter(item=>item.id!==price.id)).toEqual(defaults.filter(item=>item.id!==price.id));
  expect((await db.query('SELECT * FROM platform_connections')).rows).toHaveLength(0);
 }finally{await db.close();}
});
