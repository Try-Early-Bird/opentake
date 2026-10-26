import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../../src/main/migrations';
import {createTakes} from '../../../src/main/takes';
import {createTakeHistory} from '../../../src/main/take-history';
import {reconcileTake} from '../../../src/shared/take-snapshots';
import {visibleMessages,type TakeMessage} from '../../../src/shared/takes';
const selection={provider:'claude' as const,model:'sonnet'};
async function fixture(){const db=new PGlite();await migrate(db);const lifecycle={use:async<T>(fn:(d:PGlite)=>Promise<T>)=>fn(db)};return {db,lifecycle};}
async function add(db:PGlite,take:string,parent:string|null,text:string,role:'user'|'assistant'='user'){const message:TakeMessage={id:randomUUID(),parentId:parent,role,text,images:[],createdAt:new Date().toISOString(),selection,state:'completed',tools:[],replay:[{role:'assistant',content:[{type:'text',text:'PRIVATE-REPLAY'}]}]};await db.query('INSERT INTO take_messages(id,take_id,parent_id,data) VALUES($1,$2,$3,$4)',[message.id,take,parent,JSON.stringify(message)]);return message;}
const models=async()=>({ok:true as const,source:'runtime' as const,models:[{value:'sonnet',label:'Sonnet'}]});
test('branch pages include all ancestors once, exclude other branches and reject stale or tampered cursors',async()=>{
 const f=await fixture();const service=createTakes(f.lifecycle,async()=>{},models);
 try{await service.start();const id=await service.create();let head:string|null=null;const ids:string[]=[];
 for(let i=0;i<75;i++){head=(await add(f.db,id,head,'Message '+i)).id;ids.push(head);}
 const other=await add(f.db,id,ids[10],'Other branch');await service.update(id,{headId:head});
 const first=(await service.snapshot(id,false,undefined))!;expect(first.take!.messages).toHaveLength(30);expect(JSON.stringify(first)).not.toContain('PRIVATE-REPLAY');expect(first.messagesNext).toBeTruthy();
 const second=await service.messagesPage(id,first.messagesNext);const third=await service.messagesPage(id,second.next!);expect(third.next).toBeNull();
 expect([...third.messages,...second.messages,...first.take!.messages].map(m=>m.id)).toEqual(ids);expect(first.take!.messages.some(m=>m.id===other.id)).toBe(false);
 await expect(service.messagesPage(id,first.messagesNext+'bad')).rejects.toThrow('cursor');
 await service.update(id,{headId:other.id});await expect(service.messagesPage(id,first.messagesNext)).rejects.toThrow('branch changed');
 const newHost=createTakeHistory(f.lifecycle);await expect(newHost.messages(id,head,first.messagesNext)).rejects.toThrow('cursor');
 }finally{await service.close();await f.db.close();}
});
test('take and version pages have stable ordering, no duplicates and distinct archived scope',async()=>{
 const f=await fixture();const service=createTakes(f.lifecycle,async()=>{},models);
 try{await service.start();const ids:string[]=[];for(let i=0;i<35;i++)ids.push(await service.create());
 await f.db.exec("UPDATE takes SET updated_at='2026-10-01'");const first=(await service.snapshot(null,false,undefined))!;const second=await service.takesPage(false,first.takesNext!);expect(first.takes).toHaveLength(30);expect(second.items).toHaveLength(5);expect(new Set([...first.takes,...second.items].map(t=>t.id)).size).toBe(35);await expect(service.takesPage(true,first.takesNext!)).rejects.toThrow('list changed');
 const versions=[];for(let i=0;i<37;i++)versions.push(await add(f.db,ids[0],null,'Version '+i));
 await service.update(ids[0],{headId:versions[0].id});const snapshot=(await service.snapshot(ids[0],false,undefined))!;expect(snapshot.take!.messages[0]).toMatchObject({versionNumber:1,versionCount:37});
 const page=await service.messageVersions(ids[0],versions[0].id);const older=await service.messageVersions(ids[0],versions[0].id,page.next!);expect(page.items).toHaveLength(30);expect(older.items).toHaveLength(7);expect(older.items.at(-1)).toEqual({id:versions[0].id,number:1});expect(older.next).toBeNull();
 }finally{await service.close();await f.db.close();}
});
test('streaming snapshots send only changed messages while execution still receives the full branch',async()=>{
 const f=await fixture();let release!:()=>void;const gate=new Promise<void>(r=>release=r);let started!:()=>void;const begin=new Promise<void>(r=>started=r);let seen=0;
 const service=createTakes(f.lifecycle,async input=>{seen=input.messages.length;input.text('First delta');started();await gate;input.text(' second delta');},models);
 try{await service.start();const id=await service.create();let head:string|null=null;for(let i=0;i<65;i++)head=(await add(f.db,id,head,'History '+i)).id;await service.update(id,{headId:head});
 await service.send({takeId:id,parentId:head,requestId:randomUUID(),text:'Continue',selection});await begin;const first=(await service.snapshot(id,false,undefined))!;expect(seen).toBe(66);
 let delta;for(let i=0;i<100&&!delta;i++){await new Promise(r=>setTimeout(r,10));delta=await service.snapshot(id,false,first.revision);}
 expect(delta?.mode).toBe('merge');expect(delta?.take?.messages).toHaveLength(1);expect(delta?.take?.messages[0].text).toBe('First delta');expect(delta?.messagesNext).toBeUndefined();
 const merged=reconcileTake(first.take,delta!.take,delta!.mode);expect(visibleMessages(merged!)).toHaveLength(30);expect(visibleMessages(merged!).at(-1)?.text).toBe('First delta');
 const malformed=(await service.snapshot(id,false,'invalid'))!;expect(malformed.mode).toBe('replace');expect(malformed.take?.messages).toHaveLength(30);
 }finally{release();await service.close();await f.db.close();}
});

test('large-message pages respect a byte target without dropping history',async()=>{
 const f=await fixture();const service=createTakes(f.lifecycle,async()=>{},models);
 try{await service.start();const id=await service.create();let head:string|null=null;for(let i=0;i<20;i++)head=(await add(f.db,id,head,'x'.repeat(50000))).id;await service.update(id,{headId:head});const first=(await service.snapshot(id,false,undefined))!;expect(first.take!.messages.length).toBeLessThan(20);expect(Buffer.byteLength(JSON.stringify(first.take!.messages))).toBeLessThan(530000);const next=await service.messagesPage(id,first.messagesNext!);expect(first.take!.messages.length+next.messages.length).toBe(20);expect(next.next).toBeNull();
 }finally{await service.close();await f.db.close();}
});
