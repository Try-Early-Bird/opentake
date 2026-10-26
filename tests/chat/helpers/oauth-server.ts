import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
export async function oauthServer(){
 let sseAttempts=0;let echoToken=false;let calls=0;let origin='';let challenge='';let redirect='';let access='synthetic-access-1';let refresh='synthetic-refresh-1';let exchanges=0;let refreshes=0;let registrations=0;let rejectRefresh=false;let rejectedAccess=false;
 const server=createServer(async(req,res)=>{
  let text='';for await(const chunk of req)text+=chunk;
  const path=new URL(req.url!,origin).pathname;const json=(body:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if(path.startsWith('/.well-known/oauth-protected-resource'))return json({resource:origin+'/mcp',authorization_servers:[origin],scopes_supported:['tools:read']});
  if(path==='/.well-known/oauth-authorization-server')return json({issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:origin+'/token',registration_endpoint:origin+'/register',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],authorization_response_iss_parameter_supported:true});
  if(path==='/register'){registrations++;const client=JSON.parse(text);redirect=client.redirect_uris[0];return json({...client,client_id:'synthetic-public-client'},201);}
  if(path==='/token'){
   const params=new URLSearchParams(text);
   if(params.get('grant_type')==='refresh_token'){
    refreshes++;if(rejectRefresh||params.get('refresh_token')!==refresh)return json({error:'invalid_grant'},400);
    access='synthetic-access-'+(refreshes+1);refresh='synthetic-refresh-'+(refreshes+1);rejectedAccess=false;return json({access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600});
   }
   exchanges++;if(params.get('code')!=='synthetic-code'||params.get('redirect_uri')!==redirect||createHash('sha256').update(params.get('code_verifier')??'').digest('base64url')!==challenge)return json({error:'invalid_grant'},400);
   return json({access_token:access,refresh_token:refresh,token_type:'Bearer',expires_in:3600});
  }
  if(path==='/mcp'){
   if(req.method==='GET')sseAttempts++;
   if(req.headers.authorization!==`Bearer ${access}`||rejectedAccess){res.setHeader('WWW-Authenticate',`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);return json({error:'unauthorized'},401);}
   if(req.method==='GET')return json({},405);
   const body=JSON.parse(text||'{}');if(body.id===undefined){res.writeHead(202).end();return;}
   if(body.method==='tools/call')calls++;
   const result=body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'Synthetic',version:'1'}}:body.method==='tools/list'?{tools:[{name:'example',inputSchema:{type:'object',properties:{}}}]}:{content:[{type:'text',text:echoToken?access:'Synthetic result'}]};
   return json({jsonrpc:'2.0',id:body.id,result});
  }
  return json({},404);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
 return {url:origin+'/mcp',origin,remember:(url:string)=>{const parsed=new URL(url);challenge=parsed.searchParams.get('code_challenge')??'';redirect=parsed.searchParams.get('redirect_uri')??'';},counts:()=>({exchanges,refreshes,registrations,calls,sseAttempts}),echoToken:()=>{echoToken=true;},rejectRefresh:()=>{rejectRefresh=true;},expireAccess:()=>{rejectedAccess=true;},close:async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}
