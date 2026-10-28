// Chat asking to turn on a tool: synthetic MCP inventory and a disposable database only.
import {afterEach,expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../src/main/migrations';
import {createToolAccess} from '../../src/main/tool-access';
import type {ManagedServer,ManagedTool,TakeToolPermission,ToolPolicy} from '../../src/shared/mcp-management';

const builtin='00000000-0000-4000-8000-000000000001',external='11111111-1111-4111-8111-111111111111';
const open:PGlite[]=[];
afterEach(async()=>{for(const db of open.splice(0))await db.close();});
async function fixture(take:TakeToolPermission[]=[]){
 const db=new PGlite();open.push(db);await migrate(db);
 const takeId=randomUUID(),run=randomUUID(),message=randomUUID();
 await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Synthetic','{}' FROM local_owners",[takeId]);
 await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running','{}')",[run,takeId,randomUUID()]);
 await db.query('INSERT INTO take_messages(id,take_id,data) VALUES($1,$2,$3)',[message,takeId,JSON.stringify({role:'assistant',runId:run})]);
 const servers:ManagedServer[]=[{id:builtin,policy:'allowed',enabled:true,revision:1,config:{name:'Opentake platforms'} as never},{id:external,policy:'blocked',enabled:true,revision:1,config:{name:'Notes'} as never}];
 const tool=(server_id:string,name:string,policy:ToolPolicy):ManagedTool=>({server_id,name,policy,fingerprint:'f',definition:{name,description:`${name} description`,inputSchema:{}}});
 const changed:ManagedTool={...tool(external,'notes_send','blocked'),blocked_reason:'changed',previous_definition:{name:'notes_send',inputSchema:{properties:{}}},definition:{name:'notes_send',inputSchema:{properties:{to:{type:'string'}}}}};
 const ticker={...tool(builtin,'coinbase_products_ticker','blocked'),definition:{name:'coinbase_products_ticker',inputSchema:{},annotations:{readOnlyHint:true}}};
 const tools=[changed,ticker,tool(builtin,'opentake_propose_rules','ask'),tool(builtin,'opentake_read_rules','allowed'),tool(builtin,'opentake_request_tool_access','allowed'),tool(external,'notes_search','allowed')];
 const changes:[string,string,ToolPolicy][]=[];let live=true;
 const access=createToolAccess({list:async()=>({servers,tools}),policy:async(s,n,p)=>{changes.push([s,n,p]);tools.find(t=>t.server_id===s&&t.name===n)!.policy=p;},take:async()=>({takeId,permissions:take}),
  use:work=>work(db as never),active:()=>live});
 return {access,changes,tools,db,run,message,stop:()=>{live=false;}};
}
const ask=(name:string,policy:'ask'|'allowed'='ask',serverId=builtin)=>({serverId,name,policy,reason:'Read the BTC price'});

test('lists only tools that are off or ask first, with why, never the request tool itself',async()=>{
 const {access,run}=await fixture([{server_id:builtin,tool_name:'opentake_read_rules',policy:'blocked'}]);
 const {tools}=await access.list(run);
 expect(tools.map(t=>[t.name,t.policy,t.serverPolicy??null,t.takeRestriction??null])).toEqual([['notes_send','blocked','blocked',null],
  ['coinbase_products_ticker','blocked',null,null],['opentake_propose_rules','ask',null,null],['opentake_read_rules','allowed',null,'blocked'],['notes_search','allowed','blocked',null]]);
});

test('a request is filed on the reply and changes nothing until the member approves it, at any later time',async()=>{
 const {access,changes,run,message,stop}=await fixture();
 const filed=await access.file(run,ask('coinbase_products_ticker')) as {filed:boolean;requestId:string;note:string};
 expect(filed).toMatchObject({filed:true});expect(filed.note).toContain('Do not wait');expect(changes).toEqual([]);
 expect(await access.forMessage(message)).toEqual([expect.objectContaining({id:filed.requestId,toolName:'coinbase_products_ticker',policy:'ask',status:'pending',server:'Opentake platforms'})]);
 // The reply has ended; the member still decides.
 stop();
 expect(await access.decide(filed.requestId,'ask')).toMatchObject({changed:true,from:'blocked',to:'ask'});
 expect(changes).toEqual([[builtin,'coinbase_products_ticker','ask']]);
 expect((await access.forMessage(message))[0]).toMatchObject({status:'approved',granted:'ask',readOnly:true});
 await expect(access.decide(filed.requestId,'ask')).rejects.toThrow('already answered');
});

test('declining changes nothing, and a newer request for the same tool replaces the open one',async()=>{
 const {access,changes,run,message}=await fixture();
 const first=await access.file(run,ask('coinbase_products_ticker')) as {requestId:string};
 const second=await access.file(run,ask('coinbase_products_ticker','allowed')) as {requestId:string};
 expect((await access.forMessage(message)).map(r=>[r.id,r.status])).toEqual([[first.requestId,'superseded'],[second.requestId,'pending']]);
 await expect(access.decide(first.requestId,'allowed')).rejects.toThrow('already answered');
 await access.decide(second.requestId,'decline');expect(changes).toEqual([]);
 expect((await access.forMessage(message))[1]).toMatchObject({status:'declined',granted:null});
});

test('requests never narrow, cannot touch servers or the request tool, and need a live reply',async()=>{
 const {access,run,stop}=await fixture();
 expect(await access.file(run,ask('opentake_propose_rules'))).toMatchObject({filed:false});
 await expect(access.file(run,ask('opentake_request_tool_access','allowed'))).rejects.toThrow('its own access');
 await expect(access.file(run,ask('notes_search','allowed',external))).rejects.toThrow('Settings');
 await expect(access.file(run,ask('missing','allowed'))).rejects.toThrow('not found');
 await expect(access.file(run,{...ask('coinbase_products_ticker'),policy:'blocked'})).rejects.toThrow();
 stop();await expect(access.file(run,ask('coinbase_products_ticker'))).rejects.toThrow('Response stopped');
});

test('keep asking turns the tool on but still asks, and an answer never opens it wider than chat asked',async()=>{
 const kept=await fixture();
 const wide=await kept.access.file(kept.run,ask('coinbase_products_ticker','allowed')) as {requestId:string};
 expect(await kept.access.decide(wide.requestId,'ask')).toMatchObject({changed:true,to:'ask'});
 expect((await kept.access.forMessage(kept.message))[0]).toMatchObject({policy:'allowed',granted:'ask',status:'approved'});
 expect(kept.changes).toEqual([[builtin,'coinbase_products_ticker','ask']]);
 const capped=await fixture();
 const narrow=await capped.access.file(capped.run,ask('coinbase_products_ticker','ask')) as {requestId:string};
 await expect(capped.access.decide(narrow.requestId,'maybe')).rejects.toThrow();
 expect(await capped.access.decide(narrow.requestId,'allowed')).toMatchObject({changed:true,to:'ask'});
 expect((await capped.access.forMessage(capped.message))[0].granted).toBe('ask');
});

test('approving rechecks the tools as they are then',async()=>{
 const {access,changes,tools,run}=await fixture();
 const filed=await access.file(run,ask('coinbase_products_ticker')) as {requestId:string};
 tools.find(t=>t.name==='coinbase_products_ticker')!.policy='allowed';
 expect(await access.decide(filed.requestId,'ask')).toMatchObject({changed:false});expect(changes).toEqual([]);
});

test('a Take restriction stays and is reported to chat',async()=>{
 const {access,run}=await fixture([{server_id:builtin,tool_name:'',policy:'ask'}]);
 expect(((await access.file(run,ask('coinbase_products_ticker','allowed'))) as {note:string}).note).toContain('This Take still restricts it (ask)');
});

test('a changed tool is listed with why and what changed',async()=>{
 const {access,run}=await fixture();
 expect((await access.list(run)).tools.find(t=>t.name==='notes_send')).toMatchObject({why:'its definition changed since the member last allowed it',changes:[{field:'Input “to”',before:null,after:'type string'}]});
});
