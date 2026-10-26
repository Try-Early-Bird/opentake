// Chat asking to turn on a tool: synthetic MCP inventory only.
import {expect,test} from 'vitest';
import {createToolAccess} from '../../src/main/tool-access';
import type {ManagedServer,ManagedTool,TakeToolPermission,ToolPolicy} from '../../src/shared/mcp-management';

const builtin='00000000-0000-4000-8000-000000000001',external='11111111-1111-4111-8111-111111111111';
function fixture(take:TakeToolPermission[]=[]){
 const servers:ManagedServer[]=[{id:builtin,policy:'allowed',enabled:true,revision:1,config:{name:'Opentake platforms'} as never},{id:external,policy:'blocked',enabled:true,revision:1,config:{name:'Notes'} as never}];
 const tool=(server_id:string,name:string,policy:ToolPolicy):ManagedTool=>({server_id,name,policy,fingerprint:'f',definition:{name,description:`${name} description`,inputSchema:{}}});
 const changed:ManagedTool={...tool(external,'notes_send','blocked'),blocked_reason:'changed',previous_definition:{name:'notes_send',inputSchema:{properties:{}}},definition:{name:'notes_send',inputSchema:{properties:{to:{type:'string'}}}}};
 const tools=[changed,tool(builtin,'coinbase_products_ticker','blocked'),tool(builtin,'opentake_propose_rules','ask'),tool(builtin,'opentake_read_rules','allowed'),tool(builtin,'opentake_request_tool_access','allowed'),tool(external,'notes_search','allowed')];
 const changes:[string,string,ToolPolicy][]=[];
 const access=createToolAccess({list:async()=>({servers,tools}),policy:async(s,n,p)=>{changes.push([s,n,p]);tools.find(t=>t.server_id===s&&t.name===n)!.policy=p;},take:async()=>({takeId:'t',permissions:take})});
 return {access,changes};
}

test('lists only tools that are off or ask first, with why, never the request tool itself',async()=>{
 const {access}=fixture([{server_id:builtin,tool_name:'opentake_read_rules',policy:'blocked'}]);
 const {tools}=await access.list('run');
 expect(tools.map(t=>[t.name,t.policy,t.serverPolicy??null,t.takeRestriction??null])).toEqual([['notes_send','blocked','blocked',null],
  ['coinbase_products_ticker','blocked',null,null],['opentake_propose_rules','ask',null,null],['opentake_read_rules','allowed',null,'blocked'],['notes_search','allowed','blocked',null]]);
});

test('an approved request opens one tool, never narrows, and cannot touch servers or itself',async()=>{
 const {access,changes}=fixture();
 expect(await access.request('run',{serverId:builtin,name:'coinbase_products_ticker',policy:'ask',reason:'Read the BTC price'})).toMatchObject({changed:true,from:'blocked',to:'ask'});
 expect(await access.request('run',{serverId:builtin,name:'opentake_propose_rules',policy:'ask',reason:'Already asks'})).toMatchObject({changed:false});
 expect(changes).toEqual([[builtin,'coinbase_products_ticker','ask']]);
 await expect(access.request('run',{serverId:builtin,name:'opentake_request_tool_access',policy:'allowed',reason:'x'})).rejects.toThrow('its own access');
 await expect(access.request('run',{serverId:external,name:'notes_search',policy:'allowed',reason:'x'})).rejects.toThrow('Settings');
 await expect(access.request('run',{serverId:builtin,name:'missing',policy:'allowed',reason:'x'})).rejects.toThrow('not found');
 await expect(access.request('run',{serverId:builtin,name:'coinbase_products_ticker',policy:'blocked',reason:'x'})).rejects.toThrow();
});

test('a Take restriction stays and is reported',async()=>{
 const {access}=fixture([{server_id:builtin,tool_name:'',policy:'ask'}]);
 expect((await access.request('run',{serverId:builtin,name:'coinbase_products_ticker',policy:'allowed',reason:'Read prices'})).note).toContain('This Take still restricts it (ask)');
});

test('a changed tool is listed with why and what changed',async()=>{
 const {access}=fixture();
 expect((await access.list('run')).tools.find(t=>t.name==='notes_send')).toMatchObject({why:'its definition changed since the member last allowed it',changes:[{field:'Input “to”',before:null,after:'type string'}]});
});
