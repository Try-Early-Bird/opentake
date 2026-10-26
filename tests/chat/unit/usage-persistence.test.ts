import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createTakes} from '../../../src/main/takes';
const models=async()=>({ok:true as const,source:'runtime' as const,models:[{value:'sonnet',label:'Sonnet'}]});
const selection={provider:'claude' as const,model:'sonnet'};
test('budgets are validated and snapshotted; usage survives failures and reopening',async()=>{
 const db=new PGlite();await migrate(db);const lifecycle={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started!:()=>void;const begin=new Promise<void>(r=>started=r);let seen:unknown;
 const service=createTakes(lifecycle,async input=>{seen=input.budgets;input.text('Partial answer');input.usage?.({source:'Claude CLI',costKind:'api-equivalent',partial:true,inputTokens:42,outputTokens:5,costUsd:0.03});started();await gate;throw new Error('Response reached its budget.');},models);
 try{
  await service.start();expect(await service.budgets()).toEqual({claudeCostUsd:null,outputTokens:null,opencodeCostUsd:null});
  for(const v of [-1,0,101,NaN,'2'])await expect(service.saveBudgets({claudeCostUsd:v})).rejects.toThrow();
  for(const v of [-1,0,1.5,1000001])await expect(service.saveBudgets({claudeCostUsd:null,outputTokens:v})).rejects.toThrow();
  await service.saveBudgets({claudeCostUsd:0.02,outputTokens:100,opencodeCostUsd:0.04});const id=await service.create();await service.send({requestId:randomUUID(),takeId:id,parentId:null,text:'Test',selection});await begin;
  await service.saveBudgets({claudeCostUsd:0.5});expect(seen).toEqual({claudeCostUsd:0.02,outputTokens:100,opencodeCostUsd:0.04});release();for(let i=0;i<200&&service.busy();i++)await new Promise(r=>setTimeout(r,5));expect(service.busy()).toBe(false);await service.close();
  const history=await service.usageHistory(id);expect(history.items).toHaveLength(1);
  // The host receives an omitted cursor as null after JSON serialization.
  expect((await service.usageHistory(id,null)).items).toHaveLength(1);expect(history.items[0]).toMatchObject({state:'failed',budgets:{claudeCostUsd:0.02},usage:{inputTokens:42,costUsd:0.03,partial:true},error:'Response reached its budget.'});
  const reopened=createTakes(lifecycle,async()=>{},models);await reopened.start();expect(await reopened.budgets()).toEqual({claudeCostUsd:0.5,outputTokens:100,opencodeCostUsd:0.04});expect((await reopened.load(id)).messages.at(-1)).toMatchObject({text:'Partial answer',usage:{inputTokens:42,partial:true}});await reopened.close();
 }finally{release();await service.close();await db.close();}
});
test('usage history pages without duplicates and excludes other takes',async()=>{
 const db=new PGlite();await migrate(db);const service=createTakes({use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)},async()=>{},models);
 try{await service.start();const id=await service.create(),other=await service.create();
 for(let i=0;i<23;i++)await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration,created_at) VALUES($1,$2,$3,'completed',$4,'2026-10-01')",[randomUUID(),i===22?other:id,randomUUID(),JSON.stringify({selection})]);
 const first=await service.usageHistory(id);expect(first.items).toHaveLength(20);expect(first.next).toBeTruthy();const last=await service.usageHistory(id,first.next!);expect(last.items).toHaveLength(2);expect(last.next).toBeNull();expect(new Set([...first.items,...last.items].map(r=>r.id)).size).toBe(22);expect(first.items[0].usage).toBeNull();
 }finally{await service.close();await db.close();}
});
