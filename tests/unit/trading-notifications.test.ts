import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../src/main/migrations';
import { createNotifications, type NativeAlert } from '../../src/main/notifications';
import type { TradingQueueItem } from '../../src/shared/trading-queue';
async function fixture(){
 const db=new PGlite();await migrate(db);const strategyId=randomUUID();
 await db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategyId]);
 let now=Date.parse('2026-10-05T15:00:00Z'),fail=false;
 let items:TradingQueueItem[]=[];const calls:unknown[]=[];const alerts:NativeAlert[]=[];let badge=0;
 const service=createNotifications({use:async<T>(f:(d:PGlite)=>Promise<T>)=>f(db)},{now:()=>now,deliver:a=>alerts.push(a),badge:n=>{badge=n;},openDesktop:()=>{},trading:{list:async()=>{if(fail)throw new Error('Temporary failure');return items;},act:async(id,action)=>{calls.push([id,action]);items=items.filter(i=>i.id!==id);return items;}}});
 const item:TradingQueueItem={id:'strategy:instruction:synthetic:one',source:'strategy',state:'needs_you',title:'Invest · Synthetic',detail:'Confirm to buy VTI',reason:'awaiting_confirmation',expectedAt:null,createdAt:new Date(now).toISOString(),link:{kind:'strategy',id:strategyId},actions:['confirm','cancel'],approval:{summary:'Buy VTI',strategyName:'Synthetic'}};
 return {db,service,item,calls,alerts,get badge(){return badge;},setItems(value:TradingQueueItem[]){items=value;},advance(){now+=6000;},fail(value:boolean){fail=value;},close:async()=>{await service.stop();await db.close();}};
}
test('trading notices persist, deduplicate, route to strategy and resolve after confirmation',async()=>{
 const f=await fixture();try{
  f.setItems([f.item]);await f.service.tick();let page=await f.service.list();const notice=page.items[0];
  expect(page.actionRequiredCount).toBe(1);expect(f.badge).toBe(1);expect(f.alerts).toHaveLength(1);
  expect(notice).toMatchObject({kind:'orders_need_confirmation',trading:{queueItemId:f.item.id,actions:['confirm','cancel']}});
  expect(await f.service.target(notice.id)).toEqual({type:'strategy',strategyId:f.item.link!.id});
  f.advance();await f.service.tick();expect((await f.service.list()).items).toHaveLength(1);expect(f.alerts).toHaveLength(1);
  await f.service.act(notice.id,'confirm');expect(f.calls).toEqual([[f.item.id,'confirm']]);page=await f.service.list();expect(page.actionRequiredCount).toBe(0);expect(page.items[0].resolvedAt).not.toBeNull();
  await expect(f.service.act(notice.id,'confirm')).rejects.toThrow('changed');expect(f.calls).toHaveLength(1);
 }finally{await f.close();}
});
test('stale or unavailable queue notices cannot act on a newer trade',async()=>{
 const f=await fixture();try{
  f.setItems([f.item]);await f.service.tick();const original=(await f.service.list()).items[0];
  f.fail(true);f.advance();await f.service.tick();expect((await f.service.list()).actionRequiredCount).toBe(1);await expect(f.service.act(original.id,'cancel')).rejects.toThrow('Temporary failure');expect(f.calls).toHaveLength(0);
  f.fail(false);f.setItems([{...f.item,detail:'Confirm to buy BND',approval:{summary:'Buy BND',strategyName:'Synthetic'},createdAt:'2026-10-05T15:01:00Z'}]);
  await expect(f.service.act(original.id,'confirm')).rejects.toThrow('changed');expect(f.calls).toHaveLength(0);
  const page=await f.service.list();expect(page.items).toHaveLength(2);expect(page.actionRequiredCount).toBe(1);expect(page.items.find(i=>i.id===original.id)?.resolvedAt).not.toBeNull();
  await f.service.act(page.items[0].id,'cancel');expect(f.calls).toEqual([[f.item.id,'cancel']]);
 }finally{await f.close();}
});
test('waiting notices recover quietly, expire from attention when work advances, and preserve history',async()=>{
 const f=await fixture();try{
  f.setItems([{...f.item,state:'waiting',actions:['cancel'],approval:undefined,detail:'Waiting to settle'}]);await f.service.recover();await f.service.tick();
  const page=await f.service.list();expect(page.items[0].kind).toBe('trading_waiting');expect(page.actionRequiredCount).toBe(0);expect(f.alerts).toHaveLength(0);
  f.setItems([{...f.item,state:'in_progress',actions:[]}]);f.advance();await f.service.tick();expect((await f.service.list()).items[0].resolvedAt).not.toBeNull();expect(f.calls).toHaveLength(0);
 }finally{await f.close();}
});
