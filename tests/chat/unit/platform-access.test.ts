import { test,expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate,migrations,prepareRestoredDatabase } from '../../../src/main/migrations';
import { createPlatformAccess } from '../../../src/main/platform-access';
const builtin='00000000-0000-4000-8000-000000000001';
async function fixture(approvalMs=1000){
 const db=new PGlite();await migrate(db);let accounts=['robinhood:synthetic-account'];let active=true;
 const service=createPlatformAccess({use:async fn=>fn(db)},()=>active,{accounts:async()=>accounts,pollMs:5,approvalMs});
 const take=randomUUID();await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Test','{}' FROM local_owners",[take]);
 async function run(provider='claude',tools=true){const id=randomUUID();await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running',$4)",[id,take,randomUUID(),JSON.stringify({selection:{provider},tools:tools?[{server:builtin}]:[]})]);return id;}
 async function pending(){for(let i=0;i<100;i++){const rows=await service.pending();if(rows.length)return rows[0];await new Promise(r=>setTimeout(r,5));}throw new Error('Missing verification');}
 return {db,service,run,pending,setAccounts:(v:string[])=>{accounts=v;},stop:()=>{active=false;}};
}
test('platform data defaults to allowed and records context for later history-only runs',async()=>{
 const f=await fixture();try{expect((await f.service.settings()).verify).toBe(false);const run=await f.run();await f.service.ensure(run);expect(await f.service.pending()).toEqual([]);
 const data=(await f.db.query<{configuration:any}>('SELECT configuration FROM take_runs WHERE id=$1',[run])).rows[0].configuration;
 expect(data.platformAccess).toMatchObject({verify:false,provider:'claude',verified:false});
 await f.service.configure(true);f.setAccounts([]);const next=await f.run('claude',false);const work=f.service.ensure(next);const request=await f.pending();await f.service.decide(request.id,true);await work;
 }finally{await f.db.close();}
});
test('verification persists per take/provider and invalidates on account or setting changes',async()=>{
 const f=await fixture();try{
 await f.service.configure(true);const run=await f.run();const work=f.service.ensure(run);const request=await f.pending();await f.service.decide(request.id,true);await work;
 await expect(f.service.decide(request.id,true)).rejects.toThrow('already decided');
 await f.service.ensure(await f.run());expect(await f.service.pending()).toEqual([]);
 const other=f.service.ensure(await f.run('codex'));const otherRequest=await f.pending();await f.service.decide(otherRequest.id,true);await other;
 f.setAccounts(['robinhood:changed-account']);const changed=f.service.ensure(await f.run());const changedRequest=await f.pending();await f.service.decide(changedRequest.id,true);await changed;
 await f.service.configure(false);await f.service.configure(true);const again=f.service.ensure(await f.run());const againRequest=await f.pending();await f.service.decide(againRequest.id,true);await again;
 await prepareRestoredDatabase(f.db);expect((await f.db.query('SELECT * FROM platform_access_grants')).rows).toEqual([]);
 }finally{await f.db.close();}
});
test('an automatic rule run fails at once when verification is required and not yet granted',async()=>{
 const f=await fixture();try{
  await f.service.configure(true);const run=await f.run();
  await f.db.query("UPDATE take_runs SET configuration=jsonb_set(configuration,'{unattended}','true') WHERE id=$1",[run]);
  await expect(f.service.ensure(run)).rejects.toThrow('automatic runs cannot ask');expect(await f.service.pending()).toEqual([]);
 }finally{await f.db.close();}
});
test('decline, stop, expiry and changed account prevent verification and downstream work',async()=>{
 const f=await fixture(1000);try{
 await f.service.configure(true);const work=f.service.ensure(await f.run());const rejected=expect(work).rejects.toThrow('declined');const request=await f.pending();await f.service.decide(request.id,false);await rejected;
 const changed=f.service.ensure(await f.run());const changedRejected=expect(changed).rejects.toThrow('access changed');const changedRequest=await f.pending();f.setAccounts(['changed']);await expect(f.service.decide(changedRequest.id,true)).rejects.toThrow('no longer active');await changedRejected;
 const stopped=f.service.ensure(await f.run());const stoppedRejected=expect(stopped).rejects.toThrow('stopped');const stopRequest=await f.pending();f.stop();await stoppedRejected;await expect(f.service.decide(stopRequest.id,true)).rejects.toThrow('no longer active');
 expect((await f.db.query('SELECT * FROM platform_access_grants')).rows).toEqual([]);
 }finally{await f.db.close();}
 const expired=await fixture(40);try{await expired.service.configure(true);const work=expired.service.ensure(await expired.run());await expect(work).rejects.toThrow('expired');expect(await expired.service.pending()).toEqual([]);}finally{await expired.db.close();}
});
test('parallel checks share one prompt and restart expires outstanding requests',async()=>{
 const f=await fixture();try{await f.service.configure(true);const run=await f.run();const first=f.service.ensure(run);const second=f.service.ensure(run);expect(second).toBe(first);const rejected=expect(first).rejects.toThrow('expired');await f.pending();expect(await f.service.pending()).toHaveLength(1);await f.service.start();await rejected;expect(await f.service.pending()).toEqual([]);}finally{await f.db.close();}
});

test('platform migration preserves old messages and marks legacy context without enabling verification',async()=>{
 const db=new PGlite();try{
  await migrate(db,migrations.filter(m=>m.version<11));const previous=(await db.query('SELECT version,checksum FROM app_migrations ORDER BY version')).rows;
  const take=randomUUID();await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Legacy','{}' FROM local_owners",[take]);
  await db.query('INSERT INTO take_messages(id,take_id,data) VALUES($1,$2,$3)',[randomUUID(),take,JSON.stringify({role:'assistant',text:'Synthetic earlier response'})]);
  await migrate(db);expect((await db.query('SELECT version,checksum FROM app_migrations WHERE version<11 ORDER BY version')).rows).toEqual(previous);
  expect((await db.query<{accounts:string[]}>('SELECT accounts FROM take_platform_context')).rows[0].accounts).toEqual(['legacy-platform-context']);
  expect((await db.query<{verify:boolean}>('SELECT verify FROM platform_access_settings')).rows[0].verify).toBe(false);
  expect((await db.query<{data:{text:string}}>('SELECT data FROM take_messages')).rows[0].data.text).toBe('Synthetic earlier response');
 }finally{await db.close();}
});
