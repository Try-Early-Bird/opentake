// Grok researcher subagents against a synthetic ACP process. No Grok account, network or keychain.
import { test, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { grokExecutor, totalUsage } from '../../../src/main/grok-chat';
import type { RunInput } from '../../../src/main/take-runtime';
import type { SecretStore } from '../../../src/main/secret-store';

const credential = JSON.stringify({ 'https://auth.x.ai::fixture': { auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'fixture', key: 'synthetic-access', refresh_token: 'synthetic-refresh', user_id: 'fake-user', create_time: '2026-10-01T00:00:00Z' } });
const store: SecretStore = { available: () => true, has: async () => true, get: async () => credential, set: async () => {}, delete: async () => {}, compareAndSet: async () => true };

// Emulates Grok 1.0.70: the hook file, spawn permission, subagent notifications, and a wake turn
// after a background child. Exit codes mark what the adapter got wrong.
const fixture = String.raw`
const emit=v=>console.log(JSON.stringify({jsonrpc:'2.0',...v}));
const mode=process.argv[1],fs=require('node:fs');let promptId,lead,research;
const note=(sessionId,update)=>emit({method:'_x.ai/session_notification',params:{sessionId,update}});
const chunk=(sessionId,text,promptId)=>emit({method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}},_meta:{promptId}}});
const usage=n=>({inputTokens:n,outputTokens:1,totalTokens:n+1,cachedReadTokens:0,cacheCreationTokens:0,reasoningTokens:0,modelCalls:1});
const child=()=>{note('session',{sessionUpdate:'subagent_spawned',subagent_id:'kid',parent_session_id:'session',child_session_id:'kid'});chunk('kid','Child text','c1');
 emit({id:50,method:'_x.ai/mcp/sdk_call',params:{serverId:research,message:{jsonrpc:'2.0',id:5,method:'tools/list'}}});};
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 const e=JSON.parse(line);
 if(e.method==='initialize'){emit({id:e.id,result:{protocolVersion:1,authMethods:[{id:'cached_token'}],_meta:{agentVersion:'1.0.70','x.ai/mcp/sdk':true}}});return;}
 if(e.method==='authenticate'){emit({id:e.id,result:{}});return;}
 if(e.method==='session/new'){
  const meta=e.params._meta;if(meta.agentProfile.tools.join(',')!=='search_tool,use_tool,task')process.exit(4);
  [lead,research]=meta['x.ai/mcp/servers'].map(s=>s.serverId);if(meta['x.ai/mcp/servers'][1]?.name!=='opentake-research')process.exit(4);
  const config=fs.readFileSync('.grok/config.toml','utf8'),agent=fs.readFileSync('.grok/agents/researcher.md','utf8');
  if(!config.includes('enabled = true')||!config.includes('general-purpose = false')||config.includes('tool = "edit"')||!agent.includes('opentake-research'))process.exit(4);
  if(process.env.GROK_SUBAGENT_AWAIT_BUDGET_MS!=='3600000')process.exit(4);
  // The hook keeps a background spawn in the foreground.
  const hook=JSON.parse(fs.readFileSync('.grok/hooks/opentake.json','utf8')).hooks.PreToolUse[0].hooks[0].url;
  const answer=await (await fetch(hook,{method:'POST',body:JSON.stringify({tool_name:'spawn_subagent',tool_input:{subagent_type:'researcher',prompt:'Research',run_in_background:true}})})).json();
  if(answer.hookSpecificOutput.updatedInput.run_in_background!==false||answer.hookSpecificOutput.updatedInput.prompt!=='Research')process.exit(4);
  if((await fetch(hook.replace(/hook\/.*/,'hook/guess'),{method:'POST',body:'{}'})).status!==404)process.exit(4);
  emit({id:e.id,result:{sessionId:'session',models:{availableModels:[{modelId:'grok-fixture',name:'Grok fixture'}]}}});return;
 }
 if(e.method==='session/set_model'){emit({id:e.id,result:{}});return;}
 if(e.method==='session/prompt'){promptId=e.id;chunk('session','Lead before. ','p1');
  emit({id:40,method:'session/request_permission',params:{sessionId:'session',toolCall:{toolCallId:'call',rawInput:{variant:'Task',subagent_type:mode==='wrong-type'?'general-purpose':'researcher',run_in_background:mode==='background'}},options:[{optionId:'allow-once',kind:'allow_once'},{optionId:'reject-once',kind:'reject_once'}]}});return;}
 if(e.id===40){if(e.result?.outcome?.optionId!=='allow-once')process.exit(6);child();return;}
 if(e.id===50){
  if(e.result.result.tools.map(t=>t.name).join(',')!=='reader')process.exit(7);
  emit({id:51,method:'_x.ai/mcp/sdk_call',params:{serverId:research,message:{jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'reader',arguments:{}}}}});return;
 }
 if(e.id===51){
  if(mode==='background'){
   // The lead's turn ends first; the child finishes afterwards and Grok wakes the lead.
   note('session',{sessionUpdate:'turn_completed',prompt_id:'p1',stop_reason:'end_turn',usage:{...usage(100),usageIsIncomplete:true}});
   emit({id:promptId,result:{stopReason:'end_turn',_meta:{usage:{...usage(100),usageIsIncomplete:true}}}});
   setTimeout(()=>{note('kid',{sessionUpdate:'turn_completed',prompt_id:'c1',stop_reason:'end_turn',usage:usage(20)});
    note('session',{sessionUpdate:'subagent_finished',subagent_id:'kid',child_session_id:'kid',status:'completed',will_wake:true});
    chunk('session','Lead after research.','subagent-completed-kid');
    note('session',{sessionUpdate:'turn_completed',prompt_id:'subagent-completed-kid',stop_reason:'end_turn',usage:usage(30)});},150);
   return;
  }
  note('kid',{sessionUpdate:'turn_completed',prompt_id:'c1',stop_reason:'end_turn',usage:usage(20)});
  note('session',{sessionUpdate:'subagent_finished',subagent_id:'kid',child_session_id:'kid',status:'completed',will_wake:false});
  chunk('session','Lead after research.','p1');
  emit({id:promptId,result:{stopReason:'end_turn',_meta:{usage:usage(120)}}});
 }
});`;

function setup(mode: string) {
  const text: string[] = [], tools: { name: string; state: string }[] = [], replay: unknown[] = [], audit: any[] = [];
  const run: RunInput = { id: randomUUID(), takeId: randomUUID(), gateway: { port: 12345, token: 'a'.repeat(64) }, selection: { provider: 'grok', model: 'grok-fixture' }, instructions: 'App instructions', signal: new AbortController().signal, subagents: true,
    messages: [{ id: randomUUID(), parentId: null, role: 'user', text: 'Research my take', images: [], createdAt: new Date().toISOString(), selection: { provider: 'grok', model: 'grok-fixture' }, state: 'completed', tools: [] }],
    image: async () => '', text: v => text.push(v), tool: v => tools.push(v), replay: v => replay.push(v), audit: async e => { audit.push(e); } };
  const gatewayCall = vi.fn(async (_host, method: string) => {
    if (method === 'gateway:list') return [{ name: 'reader', inputSchema: { type: 'object' } }, { name: 'opentake_propose_strategy', inputSchema: { type: 'object' } }];
    if (method === 'gateway:instructions') return 'Gateway guidance';
    return { content: [{ type: 'text', text: 'quote' }] };
  });
  const deps = { command: () => ({ executable: process.execPath, args: [] }), version: async () => {}, confine: (c: any) => c, gatewayCall: gatewayCall as any,
    launch: ((_exe, _args, options) => spawn(process.execPath, ['-e', fixture, mode], options)) as typeof spawn };
  return { run, text, tools, replay, audit, deps };
}

test('the hook keeps a researcher in the foreground; it gets read tools only and its text stays out of the reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-sub-')), f = setup('foreground');
  try {
    await grokExecutor(store, root, f.deps)(f.run);
    expect(f.text.join('')).toBe('Lead before. Lead after research.');
    expect(f.tools.map(t => `${t.name}:${t.state}`)).toEqual(['reader:running', 'reader:completed']);
    expect(JSON.stringify(f.replay)).not.toContain('reader');
    expect(f.audit.find(e => e.kind === 'usage.recorded').payload.usage.inputTokens).toBe(120);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a researcher that ran in the background is waited for: the wake turn joins the reply and usage adds up', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-sub-')), f = setup('background');
  try {
    await grokExecutor(store, root, f.deps)(f.run);
    expect(f.text.join('')).toBe('Lead before. Lead after research.');
    const usage = f.audit.find(e => e.kind === 'usage.recorded').payload;
    expect(usage).toMatchObject({ backgroundSubagents: 1, usage: { inputTokens: 150, modelCalls: 3 } });
    expect(usage.usage.usageIsIncomplete).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a spawn of any other subagent type is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-sub-')), f = setup('wrong-type');
  try { await expect(grokExecutor(store, root, f.deps)(f.run)).rejects.toThrow(); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test('usage is incomplete when a piece is missing, as for a cancelled child', () => {
  expect(totalUsage([{ inputTokens: 1, modelCalls: 1 }, { inputTokens: 2, modelCalls: 1 }])).toMatchObject({ inputTokens: 3, modelCalls: 2 });
  expect(totalUsage([{ inputTokens: 1 }, undefined]).usageIsIncomplete).toBe(true);
});
