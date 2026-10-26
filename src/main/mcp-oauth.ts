import { createServer } from 'node:http';
import { randomBytes,randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { auth,type OAuthClientProvider,type OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed,OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { SecretStore } from './secret-store';
import type { createDatabaseLifecycle } from './database';
import type { ManagedServer } from '../shared/mcp-management';
type Database=Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
type Saved={url:string;redirect:string;client?:OAuthClientInformationMixed;tokens?:OAuthTokens;expires?:number;discovery?:OAuthDiscoveryState;issuerResponseRequired?:boolean};
const local=(host:string)=>['127.0.0.1','localhost','[::1]'].includes(host);
export async function validateOAuthURL(value:string,resource:string){
 const url=new URL(value);const root=new URL(resource);
 if(url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&local(url.hostname)&&local(root.hostname)))throw new Error('Unsupported OAuth endpoint.');
 if(url.origin===root.origin||local(root.hostname)&&local(url.hostname))return url;
 const addresses=await lookup(url.hostname,{all:true});
 if(!addresses.length||addresses.some(({address})=>/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::|f[cd]|fe[89ab]|::ffff:)/i.test(address)))throw new Error('OAuth endpoint is not public.');
 return url;
}
export function createMcpOAuth(db:Database,store:SecretStore,openBrowser:(url:string)=>Promise<void>,options:{timeoutMs?:number;fetch?:typeof fetch}={}){
 const sensitive=new Map<string,Set<string>>();
 function remember(id:string,...values:(string|undefined)[]){const known=sensitive.get(id)??new Set<string>();for(const value of values)if(value)known.add(value);sensitive.set(id,known);}
 const flows=new Map<string,{cancel:()=>void;done:Promise<void>}>();
 const providers=new Map<string,{ref:string;url:string;adapter:Awaited<ReturnType<typeof build>>}>();
 const operations=new Map<string,Promise<unknown>>();
 function serial<T>(id:string,work:()=>Promise<T>):Promise<T>{const next=(operations.get(id)??Promise.resolve()).catch(()=>{}).then(work);operations.set(id,next);void next.finally(()=>{if(operations.get(id)===next)operations.delete(id);}).catch(()=>{});return next;}
 async function row(id:string){return (await db.use(d=>d.query<{credential_ref:string|null;state:string}>('SELECT credential_ref,state FROM mcp_oauth_connections WHERE server_id=$1',[id]))).rows[0];}
 async function state(id:string,value:string,ref?:string){await db.use(d=>d.query('UPDATE mcp_oauth_connections SET state=$2,updated_at=now() WHERE server_id=$1 AND ($3::text IS NULL OR credential_ref=$3)',[id,value,ref??null]));}
 async function build(s:ManagedServer,ref:string,saved:Saved,interactive?:{state:string;signal:AbortSignal;redirect:(url:URL)=>Promise<void>}){
  remember(s.id,saved.tokens?.access_token,saved.tokens?.refresh_token,saved.client?.client_secret);
  let verifier='';let refreshing:Promise<void>|undefined;
  let tokenRefresh:{token:string;response:Promise<Response>}|undefined;
  const valid=async()=>{if(interactive?.signal.aborted)throw new Error('Sign-in cancelled.');if((await row(s.id))?.credential_ref!==ref)throw new Error('MCP authorization changed.');};
  const persist=async()=>{await valid();await store.set(ref,JSON.stringify(saved));try{await valid();}catch(error){await store.delete(ref);throw error;}};
  const guardedFetch:typeof fetch=async(input,init)=>{
   await valid();const value=typeof input==='string'?input:input instanceof URL?input.href:input.url;
   await validateOAuthURL(value,s.config.url);
   const signals=[AbortSignal.timeout(20000),...(interactive?[interactive.signal]:[]),...(init?.signal?[init.signal]:[])];
   const send=()=> (options.fetch??fetch)(input,{...init,redirect:'error',signal:AbortSignal.any(signals)});
   const body=init?.body instanceof URLSearchParams?init.body:typeof init?.body==='string'?new URLSearchParams(init.body):undefined;
   const refreshToken=value===saved.discovery?.authorizationServerMetadata?.token_endpoint&&body?.get('grant_type')==='refresh_token'?body.get('refresh_token'):null;
   // The SDK's background SSE connection and a POST may both encounter a 401.
   // Reuse that refresh response so rotating credentials are exchanged only once.
   let response:Response;
   if(refreshToken){
    if(tokenRefresh?.token!==refreshToken){const response=send();tokenRefresh={token:refreshToken,response};void response.catch(()=>{if(tokenRefresh?.response===response)tokenRefresh=undefined;});}
    response=(await tokenRefresh!.response).clone();
   }else response=await send();
   if(value===saved.discovery?.authorizationServerMetadata?.token_endpoint&&(response.status===400||response.status===401))await state(s.id,'reauth_required',ref);
   if(response.ok&&/\/.well-known\/(oauth-authorization-server|openid-configuration)/.test(new URL(value).pathname)){
    const metadata=await response.clone().json() as {authorization_response_iss_parameter_supported?:boolean};
    saved.issuerResponseRequired=metadata.authorization_response_iss_parameter_supported===true;
   }
   return response;
  };
  const provider:OAuthClientProvider={
   get redirectUrl(){return saved.redirect;},
   get clientMetadata(){return {client_name:'Opentake',redirect_uris:[saved.redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'};},
   clientMetadataUrl:s.config.oauthMetadataUrl||undefined,
   state:()=>interactive?.state??randomBytes(32).toString('hex'),
   clientInformation:async()=>{await valid();return saved.client??(s.config.oauthClientId?{client_id:s.config.oauthClientId}:undefined);},
   saveClientInformation:async value=>{await valid();saved.client=value;remember(s.id,value.client_secret);await persist();},
   tokens:async()=>{await valid();return saved.tokens;},
   saveTokens:async value=>{await valid();remember(s.id,value.access_token,value.refresh_token);saved.tokens={...value,refresh_token:value.refresh_token??saved.tokens?.refresh_token};saved.expires=value.expires_in!==undefined?Date.now()+value.expires_in*1000:undefined;await persist();await state(s.id,'connected',ref);},
   saveCodeVerifier:async value=>{await valid();if(!interactive){await state(s.id,'reauth_required',ref);throw new Error('Reconnect this MCP in Settings.');}verifier=value;},
   codeVerifier:()=>{if(!verifier)throw new Error('Sign-in expired.');return verifier;},
   redirectToAuthorization:async url=>{await valid();if(!interactive){await state(s.id,'reauth_required',ref);throw new Error('Reconnect this MCP in Settings.');}await validateOAuthURL(url.href,s.config.url);await interactive.redirect(url);},
   discoveryState:async()=>{await valid();return saved.discovery;},
   saveDiscoveryState:async value=>{
    await valid();await validateOAuthURL(value.authorizationServerUrl,s.config.url);
    const metadata=value.authorizationServerMetadata;
    if(metadata?.issuer&&new URL(metadata.issuer).href!==new URL(value.authorizationServerUrl).href)throw new Error('OAuth issuer mismatch.');
    if(saved.discovery&&saved.discovery.authorizationServerUrl!==value.authorizationServerUrl)throw new Error('OAuth issuer changed. Reconnect in Settings.');
    for(const endpoint of [metadata?.authorization_endpoint,metadata?.token_endpoint,metadata?.registration_endpoint])if(endpoint)await validateOAuthURL(endpoint,s.config.url);
    saved.discovery=value;await persist();
   },
   invalidateCredentials:async scope=>{await valid();if(scope==='all'||scope==='tokens') {delete saved.tokens;delete saved.expires;await state(s.id,'reauth_required',ref);}if(scope==='all'||scope==='client')delete saved.client;if(scope==='all'||scope==='discovery')delete saved.discovery;if(scope==='all'||scope==='verifier')verifier='';await persist();},
  };
  async function ready(){
   await valid();if(!saved.tokens)throw new Error('Connect this MCP in Settings.');
   if(saved.expires&&saved.expires<Date.now()+30000){
    if(!refreshing)refreshing=auth(provider,{serverUrl:s.config.url,fetchFn:guardedFetch}).then(result=>{if(result!=='AUTHORIZED')throw new Error('Sign-in required.');}).catch(async()=>{await state(s.id,'reauth_required',ref);throw new Error('Reconnect this MCP in Settings.');}).finally(()=>{refreshing=undefined;});
    await refreshing;
   }
   return {provider,fetch:guardedFetch,valid};
  }
  return {provider,fetch:guardedFetch,valid,ready,issuer:()=>saved.discovery?.authorizationServerUrl,issuerRequired:()=>saved.issuerResponseRequired===true};
 }
 async function disconnect(id:string){
  const flow=flows.get(id);flow?.cancel();await flow?.done.catch(()=>{});
  providers.delete(id);const current=await row(id);
  await db.use(d=>d.query("UPDATE mcp_oauth_connections SET credential_ref=NULL,state='disconnected',updated_at=now() WHERE server_id=$1",[id]));
  if(current?.credential_ref)await store.delete(current.credential_ref);
 }
 return {
  redact(id:string,value:string){for(const secret of sensitive.get(id)??[])value=value.split(secret).join('[redacted]');return value;},
  async status(id:string){const current=await row(id);return {state:current?.state??'disconnected'};},
  async start(s:ManagedServer){
   if(!s.config.oauth||s.config.transport!=='http')throw new Error('OAuth requires a remote MCP.');
   if(flows.has(s.id))return;
   if(!store.available())throw new Error('Secure storage unavailable.');
   await disconnect(s.id);
   const ref='mcp:oauth:'+randomUUID();
   await db.use(d=>d.query("INSERT INTO mcp_oauth_connections(server_id,credential_ref,state) VALUES($1,$2,'connecting') ON CONFLICT(server_id) DO UPDATE SET credential_ref=excluded.credential_ref,state='connecting',updated_at=now()",[s.id,ref]));
   const controller=new AbortController();const nonce=randomBytes(32).toString('hex');
   let resolveCode!:(code:string)=>void;let rejectCode!:(error:Error)=>void;let used=false;
   const code=new Promise<string>((resolve,reject)=>{resolveCode=resolve;rejectCode=reject;});void code.catch(()=>{});
   let adapter:Awaited<ReturnType<typeof build>>;
   const listener=createServer((req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'");res.setHeader('Referrer-Policy','no-referrer');
    const callback=new URL(req.url??'/',`http://127.0.0.1`);
    if(req.method!=='GET'||callback.pathname!=='/oauth/callback'||req.headers.host!==`127.0.0.1:${(listener.address() as {port:number}).port}`||callback.searchParams.getAll('state').length!==1||callback.searchParams.get('state')!==nonce||used){res.writeHead(400).end('Invalid or expired sign-in.');return;}
    const issuer=callback.searchParams.get('iss');
    if((adapter.issuerRequired()&&!issuer)||(issuer&&issuer!==adapter.issuer())){res.writeHead(400).end('Invalid sign-in issuer.');return;}
    used=true;
    if(callback.searchParams.has('error')){rejectCode(new Error('Sign-in declined.'));res.end('Sign-in declined. Return to Opentake.');return;}
    const value=callback.searchParams.get('code');if(!value||value.length>4096||callback.searchParams.getAll('code').length!==1){rejectCode(new Error('Invalid sign-in response.'));res.writeHead(400).end('Invalid sign-in response.');return;}
    resolveCode(value);res.end('Sign-in received. Return to Opentake.');
   });
   const done=(async()=>{
    const timeout=setTimeout(()=>controller.abort(),options.timeoutMs??180000);
    controller.signal.addEventListener('abort',()=>rejectCode(new Error('Sign-in cancelled or expired.')),{once:true});
    try{
     await new Promise<void>((resolve,reject)=>{listener.once('error',reject);listener.listen(s.config.oauthRedirectPort??0,'127.0.0.1',resolve);});
     const redirect=`http://127.0.0.1:${(listener.address() as {port:number}).port}/oauth/callback`;
     adapter=await build(s,ref,{url:s.config.url,redirect}, {state:nonce,signal:controller.signal,redirect:url=>openBrowser(url.href)});
     if(await auth(adapter.provider,{serverUrl:s.config.url,fetchFn:adapter.fetch})==='REDIRECT')await auth(adapter.provider,{serverUrl:s.config.url,authorizationCode:await code,fetchFn:adapter.fetch});
     await adapter.valid();await state(s.id,'connected',ref);
    }catch{await state(s.id,controller.signal.aborted?'cancelled':'reauth_required',ref);}
    finally{clearTimeout(timeout);listener.closeAllConnections();await new Promise<void>(resolve=>listener.close(()=>resolve()));flows.delete(s.id);}
   })();
   flows.set(s.id,{done,cancel:()=>controller.abort()});void done.catch(()=>{});
  },
  async cancel(id:string){const flow=flows.get(id);flow?.cancel();await flow?.done.catch(()=>{});},
  disconnect,
  async provider(s:ManagedServer){
   const current=await row(s.id);if(!current?.credential_ref||current.state!=='connected')throw new Error('Connect this MCP in Settings.');
   return serial(s.id,async()=>{
    const cached=providers.get(s.id);
    if(cached?.ref===current.credential_ref&&cached.url===s.config.url)return cached.adapter.ready();
    // Never return credentials over RPC or include them in audit payloads.
    const raw=await store.get(current.credential_ref!);if(!raw)throw new Error('Reconnect this MCP in Settings.');
    const saved=JSON.parse(raw) as Saved;if(saved.url!==s.config.url)throw new Error('MCP authorization changed.');
    const adapter=await build(s,current.credential_ref!,saved);providers.set(s.id,{ref:current.credential_ref!,url:s.config.url,adapter});return adapter.ready();
   });
  },
  serial,
  async failed(id:string){await state(id,'reauth_required');},
  async recover(){await db.use(d=>d.query("UPDATE mcp_oauth_connections SET state='reauth_required' WHERE state='connecting'"));},
  async close(){for(const flow of flows.values())flow.cancel();await Promise.allSettled([...flows.values()].map(f=>f.done));},
 };
}
