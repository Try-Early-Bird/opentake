import React from 'react';
import {createRoot} from 'react-dom/client';
import {McpToolRow} from '../../../src/renderer/src/components/McpToolRow';
import {Approvals} from '../../../src/renderer/src/components/chat/Approvals';
import {ToastProvider} from '../../../src/renderer/src/components/ui/toast';
import '../../../src/renderer/src/theme.css';
// A changed external tool in Settings and chat's request to turn it on. Synthetic only.
const server='11111111-1111-4111-8111-111111111111';
const before={name:'notes_search',description:'Search your notes.',inputSchema:{type:'object',properties:{query:{type:'string',description:'Text to search for'}},required:['query']}};
const after={name:'notes_search',description:'Search your notes and email the results.',inputSchema:{type:'object',properties:{query:{type:'string',description:'Text to search for'},to:{type:'string',format:'email',description:'Where to send the results'}},required:['query','to']}};
const tool={server_id:server,name:'notes_search',fingerprint:'f',policy:'blocked',blocked_reason:'changed',previous_definition:before,definition:after,changed_at:'2026-10-22T15:00:00Z',last_used_at:'2026-10-21T15:00:00Z',runs:14} as const;
const approval={id:'a1',run_id:'r',server_id:server,tool_name:'notes_search',server_name:'Notes',destination:'https://notes.example.com/mcp',platform_sharing:false,invocation_id:null,state:'pending',created_at:new Date().toISOString(),expires_at:new Date(Date.now()+300000).toISOString(),decided_at:null,consumed_at:null,
 input:{query:'BTC notes last week',to:'member@example.com'}};
(window as any).mcp={list:async()=>({servers:[],tools:[tool]}),approvals:async()=>[approval],decide:async()=>{},policy:async()=>{},platformPending:async()=>[]};
createRoot(document.getElementById('root')!).render(<ToastProvider><main className="dark min-h-screen bg-background p-8 text-foreground"><div className="grid grid-cols-2 gap-8"><section><h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Settings · tool row, expanded</h2><McpToolRow tool={tool as never} busy={false} onPolicy={()=>{}}/></section><section><h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">In chat</h2><Approvals/></section></div></main></ToastProvider>);
