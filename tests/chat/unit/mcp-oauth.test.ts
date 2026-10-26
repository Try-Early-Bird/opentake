import { createMcpManagement } from '../../../src/main/mcp-management';
import { test,expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpOAuth,validateOAuthURL } from '../../../src/main/mcp-oauth';
import { migrate,prepareRestoredDatabase } from '../../../src/main/migrations';
import type { SecretStore } from '../../../src/main/secret-store';
import type { ManagedServer } from '../../../src/shared/mcp-management';
import { oauthServer } from '../helpers/oauth-server';
async function fixture(timeoutMs=10000){
 const remote=await oauthServer();const db=new PGlite();await migrate(db);const values=new Map<string,string>();let authorization='';
 const store:SecretStore={available:()=>true,get:async key=>values.get(key)??null,has:async key=>values.has(key),set:async(key,value)=>{values.set(key,value);},delete:async key=>{values.delete(key);}};
 const s:ManagedServer={id:randomUUID(),revision:1,enabled:false,policy:'allowed',config:{name:'Synthetic OAuth',url:remote.url,transport:'http',oauth:true,command:'',args:[],env:{},bindings:[]}};
 await db.query('INSERT INTO mcp_servers(id,config) VALUES($1,$2)',[s.id,JSON.stringify(s.config)]);
 const oauth=createMcpOAuth({use:async fn=>fn(db)},store,async url=>{authorization=url;remote.remember(url);},{timeoutMs});
 async function waitFor(state:string){for(let i=0;i<300;i++){if((await oauth.status(s.id)).state===state)return;await new Promise(r=>setTimeout(r,5));}throw new Error('State not reached: '+state);}
 async function start(){await oauth.start(s);for(let i=0;i<300&&!authorization;i++)await new Promise(r=>setTimeout(r,5));expect(authorization).toBeTruthy();return new URL(authorization);}
 function callback(url:URL){const cb=new URL(url.searchParams.get('redirect_uri')!);cb.searchParams.set('state',url.searchParams.get('state')!);cb.searchParams.set('code','synthetic-code');cb.searchParams.set('iss',remote.origin);return cb;}
 async function login(){const url=await start();await fetch(callback(url));await waitFor('connected');}
 return {remote,db,store,values,s,oauth,start,callback,login,waitFor,close:async()=>{await oauth.close();await db.close();await remote.close();}};
}
test('SDK OAuth uses discovery, PKCE and state/issuer validation; HTTP transport refreshes tokens',async()=>{
 const f=await fixture();let client:Client|undefined;try{
  const url=await f.start();expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  const invalid=f.callback(url);invalid.searchParams.set('state','wrong');expect((await fetch(invalid)).status).toBe(400);
  const wrongIssuer=f.callback(url);wrongIssuer.searchParams.set('iss','https://wrong.example');expect((await fetch(wrongIssuer)).status).toBe(400);
  const noIssuer=f.callback(url);noIssuer.searchParams.delete('iss');expect((await fetch(noIssuer)).status).toBe(400);
  expect(f.remote.counts().exchanges).toBe(0);await fetch(f.callback(url));await f.waitFor('connected');
  const adapter=await f.oauth.provider(f.s);client=new Client({name:'test',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(f.remote.url),{authProvider:adapter.provider,fetch:adapter.fetch}));
  // Finish the initial optional SSE probe before deliberately expiring access.
  for(let i=0;i<200&&!f.remote.counts().sseAttempts;i++)await new Promise(r=>setTimeout(r,5));
  expect(f.remote.counts().sseAttempts).toBe(1);
  f.remote.expireAccess();expect((await client.listTools()).tools[0].name).toBe('example');expect(f.remote.counts().refreshes).toBe(1);
  const ref=(await f.db.query<{credential_ref:string}>('SELECT credential_ref FROM mcp_oauth_connections')).rows[0].credential_ref;
  expect(JSON.parse(f.values.get(ref)!).tokens.refresh_token).toBe('synthetic-refresh-2');
  expect(JSON.stringify((await f.db.query('SELECT * FROM mcp_oauth_connections')).rows)).not.toContain('synthetic-access');
  await f.oauth.disconnect(f.s.id);await expect(adapter.provider.tokens()).rejects.toThrow('changed');expect(f.values.size).toBe(0);
 }finally{await client?.close();await f.close();}
});
test('expired tokens refresh proactively and failed refresh requires sign-in without opening a browser',async()=>{
 const f=await fixture();try{
  await f.login();const ref=(await f.db.query<{credential_ref:string}>('SELECT credential_ref FROM mcp_oauth_connections')).rows[0].credential_ref;
  const saved=JSON.parse(f.values.get(ref)!);saved.expires=Date.now()-1000;f.values.set(ref,JSON.stringify(saved));
  await Promise.all([f.oauth.provider(f.s),f.oauth.provider(f.s)]);expect(f.remote.counts().refreshes).toBe(1);
  const adapter=await f.oauth.provider(f.s);f.remote.rejectRefresh();
  await adapter.provider.saveTokens({...await adapter.provider.tokens()!,expires_in:1});
  await expect(f.oauth.provider(f.s)).rejects.toThrow('Reconnect');expect((await f.oauth.status(f.s.id)).state).toBe('reauth_required');
  expect(f.remote.counts().registrations).toBe(1);
 }finally{await f.close();}
});
// Each scenario owns one migrated database and its own timeout budget. Combining
// four fixture lifecycles exceeded 30 seconds on contended Windows CI runners.
test('cancel invalidates the sign-in session and closes its callback listener',async()=>{
 const f=await fixture();try{
  const url=await f.start();await f.oauth.cancel(f.s.id);
  expect((await f.oauth.status(f.s.id)).state).toBe('cancelled');
  await expect(fetch(f.callback(url),{signal:AbortSignal.timeout(5000)})).rejects.toMatchObject({cause:{code:'ECONNREFUSED'}});
  expect(f.remote.counts().exchanges).toBe(0);
 }finally{await f.close();}
});
test('denial invalidates the sign-in session without exchanging a code',async()=>{
 const f=await fixture();try{
  const url=await f.start();const cb=f.callback(url);cb.searchParams.set('error','access_denied');
  await fetch(cb);await f.waitFor('reauth_required');expect(f.remote.counts().exchanges).toBe(0);
 }finally{await f.close();}
});
test('timeout invalidates the sign-in session',async()=>{
 const f=await fixture(1000);try{await f.start();await f.waitFor('cancelled');}finally{await f.close();}
});
test('restore invalidates the connected sign-in session',async()=>{
 const f=await fixture();try{
  await f.login();await prepareRestoredDatabase(f.db);
  await expect(f.oauth.provider(f.s)).rejects.toThrow('Connect');
  expect((await f.oauth.status(f.s.id)).state).toBe('disconnected');
 }finally{await f.close();}
});
test('OAuth rejects unsafe endpoints and does not send revoked tokens after disconnect',async()=>{
 await expect(validateOAuthURL('http://remote.example/token','https://mcp.example/mcp')).rejects.toThrow();await expect(validateOAuthURL('https://user:pass@example.com/token','https://mcp.example/mcp')).rejects.toThrow();await expect(validateOAuthURL('https://127.0.0.1/token','https://mcp.example/mcp')).rejects.toThrow();
 const f=await fixture();try{await f.login();const adapter=await f.oauth.provider(f.s);await f.oauth.disconnect(f.s.id);await expect(adapter.provider.saveTokens({access_token:'synthetic-late',token_type:'Bearer'})).rejects.toThrow('changed');expect(f.values.size).toBe(0);}finally{await f.close();}
});

test('pre-registered public client skips dynamic registration',async()=>{
 const f=await fixture();try{f.s.config.oauthClientId='synthetic-registered-client';await f.login();expect(f.remote.counts().registrations).toBe(0);expect(f.remote.counts().exchanges).toBe(1);}finally{await f.close();}
});
test('managed OAuth MCP discovers tools, refreshes without browser prompts and redacts tokens',async()=>{
 const remote=await oauthServer();const db=new PGlite();await migrate(db);const values=new Map<string,string>();let browserCount=0;
 const store:SecretStore={available:()=>true,get:async key=>values.get(key)??null,has:async key=>values.has(key),set:async(key,value)=>{values.set(key,value);},delete:async key=>{values.delete(key);}};
 const mcp=createMcpManagement({use:async fn=>fn(db)},store,'/unused-synthetic',()=>true,async()=>({content:[]}),undefined,{openBrowser:async url=>{
  browserCount++;remote.remember(url);const auth=new URL(url);const callback=new URL(auth.searchParams.get('redirect_uri')!);callback.searchParams.set('state',auth.searchParams.get('state')!);callback.searchParams.set('code','synthetic-code');callback.searchParams.set('iss',remote.origin);await fetch(callback);
 }});
 try{
  await mcp.start();const id=await mcp.save(null,{name:'OAuth fixture',url:remote.url,transport:'http',oauth:true,command:'',args:[],env:{},bindings:[]});await mcp.oauthStart(id);
  for(let i=0;i<300&&(await mcp.oauthStatus(id)).state!=='connected';i++)await new Promise(r=>setTimeout(r,5));expect((await mcp.oauthStatus(id)).state).toBe('connected');
  await mcp.discover(id);await mcp.policy(id,'example','allowed');await mcp.enable(id,true);
  const take=randomUUID();const run=randomUUID();const snapshot=(await mcp.policySnapshot()).filter(t=>t.server===id);
  await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Synthetic','{}' FROM local_owners",[take]);await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running',$4)",[run,take,randomUUID(),JSON.stringify({selection:{provider:'claude'},tools:snapshot})]);
  remote.expireAccess();remote.echoToken();const result=await mcp.call(run,snapshot[0].alias,{});expect(result.isError).not.toBe(true);expect(JSON.stringify(result)).toContain('[redacted]');expect(JSON.stringify(result)).not.toContain('synthetic-access');expect(browserCount).toBe(1);expect(remote.counts().refreshes).toBe(1);
  await mcp.oauthDisconnect(id);expect((await mcp.call(run,snapshot[0].alias,{})).isError).toBe(true);expect(remote.counts().calls).toBe(1);expect(values.size).toBe(0);
 }finally{await mcp.close();await db.close();await remote.close();}
});


test('overlapping refresh requests reuse one rotating-token exchange',async()=>{
 const f=await fixture();try{
  await f.login();const adapter=await f.oauth.provider(f.s);const tokens=await adapter.provider.tokens();
  const init={method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',refresh_token:tokens!.refresh_token!,client_id:'synthetic-public-client'})};
  const responses=await Promise.all([adapter.fetch(f.remote.origin+'/token',init),adapter.fetch(f.remote.origin+'/token',init)]);
  const bodies=await Promise.all(responses.map(r=>r.json()));expect(bodies[0]).toEqual(bodies[1]);expect(f.remote.counts().refreshes).toBe(1);
 }finally{await f.close();}
});
