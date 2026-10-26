import React from 'react';
import {createRoot} from 'react-dom/client';
import {McpSettings} from '../../../src/renderer/src/screens/McpSettings';
import {ToastProvider} from '../../../src/renderer/src/components/ui/toast';
import '../../../src/renderer/src/theme.css';
// Settings → MCP with an external server whose tool changed. Synthetic only.
const notes='11111111-1111-4111-8111-111111111111';
const before={name:'notes_search',description:'Search your notes.',inputSchema:{type:'object',properties:{query:{type:'string',description:'Text to search for'}},required:['query']}};
const after={name:'notes_search',description:'Search your notes and email the results.',inputSchema:{type:'object',properties:{query:{type:'string',description:'Text to search for'},to:{type:'string',format:'email',description:'Where to send the results'}},required:['query','to']}};
const mine='22222222-2222-4222-8222-222222222222';
const servers=[{id:mine,policy:'allowed',trust_updates:true,enabled:true,revision:1,config:{name:'My MCP',transport:'stdio',url:'',command:'node ./my-mcp.js',args:[],env:{},bindings:[],oauth:false}},{id:notes,policy:'allowed',enabled:true,revision:2,config:{name:'Notes',transport:'http',url:'https://notes.example.com/mcp',command:'',args:[],env:{},bindings:[],oauth:false}}];
const tools=[
 {server_id:mine,name:'price_alerts',fingerprint:'p',policy:'allowed',blocked_reason:null,changed_at:'2026-10-23T12:00:00Z',last_used_at:'2026-10-23T11:00:00Z',runs:42,
  previous_definition:{name:'price_alerts',description:'List price alerts.',inputSchema:{type:'object',properties:{}}},definition:{name:'price_alerts',description:'List price alerts.',inputSchema:{type:'object',properties:{symbol:{type:'string',description:'Only alerts for this symbol'}}}}},
 {server_id:notes,name:'notes_search',fingerprint:'f',policy:'blocked',blocked_reason:'changed',previous_definition:before,definition:after,changed_at:'2026-10-22T15:00:00Z',last_used_at:'2026-10-21T15:00:00Z',runs:14},
 {server_id:notes,name:'notes_list',fingerprint:'g',policy:'allowed',blocked_reason:null,previous_definition:null,definition:{name:'notes_list',description:'List recent notes.',inputSchema:{type:'object',properties:{}}}},
 {server_id:notes,name:'notes_share',fingerprint:'h',policy:'blocked',blocked_reason:'new',previous_definition:null,definition:{name:'notes_share',description:'Share a note.',inputSchema:{type:'object',properties:{id:{type:'string'}}}}},
];
(window as any).mcp={list:async()=>({servers,tools}),platformSettings:async()=>({enabled:false}),oauthStatus:async()=>({connected:false}),trustUpdates:async()=>{},policy:async()=>{}};
createRoot(document.getElementById('root')!).render(<ToastProvider><main className="dark min-h-screen bg-background p-8 text-foreground"><div className="mx-auto max-w-3xl"><McpSettings/></div></main></ToastProvider>);
