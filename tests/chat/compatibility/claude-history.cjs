// Opt-in installed CLI check. All requests use a synthetic local HTTP server.
if (!process.env.OPENTAKE_TEST_CLAUDE) throw new Error('Set OPENTAKE_TEST_CLAUDE to an absolute installed CLI path.');
const {spawn}=require('node:child_process');const {createServer}=require('node:http');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {randomUUID}=require('node:crypto');
(async()=>{const home=await fs.mkdtemp(path.join(os.tmpdir(),'opentake-history-probe-'));let seen=[];
const server=createServer(async(req,res)=>{let s='';for await(const c of req)s+=c;const b=JSON.parse(s||'{}');
if(req.url.includes('count_tokens')){res.end(JSON.stringify({input_tokens:50}));return;}
if(req.url.includes('/messages')){seen.push((b.messages||[]).map(m=>({role:m.role,content:m.content})));const msg={id:'msg_synthetic',type:'message',role:'assistant',content:[],model:'claude-sonnet-4-6',stop_reason:null,stop_sequence:null,usage:{input_tokens:50,output_tokens:0}};
res.writeHead(200,{'Content-Type':'text/event-stream'});
for(const [type,data] of [['message_start',{message:msg}],['content_block_start',{index:0,content_block:{type:'text',text:''}}],['content_block_delta',{index:0,delta:{type:'text_delta',text:'Probe complete.'}}],['content_block_stop',{index:0}],['message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}}],['message_stop',{}]])res.write(`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`);res.end();return;}res.writeHead(404).end();});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try{const {claudeHistory,claudeHistoryVersion}=await import('../../../src/main/claude-history.ts');
const version=await claudeHistoryVersion({executable:process.env.OPENTAKE_TEST_CLAUDE,args:[]},home);
const base={id:randomUUID(),parentId:null,images:[],createdAt:new Date().toISOString(),selection:{provider:'claude',model:'default'},state:'completed',tools:[]};
const transcript=path.join(home,'replay.jsonl');await fs.writeFile(transcript,await claudeHistory([
{...base,role:'user',text:'Retrieve the synthetic marker.'},
{...base,role:'assistant',text:'I retrieved the marker.',replay:[
{role:'assistant',content:[{type:'tool_use',id:'toolu_marker',name:'mcp__opentake__marker',input:{}}]},
{role:'user',content:[{type:'tool_result',tool_use_id:'toolu_marker',content:'SYNTHETIC-RESULT-452',is_error:false}]},
{role:'assistant',content:[{type:'text',text:'I retrieved the marker.'}]}]}],async()=>'',home,version),{mode:0o600});
const env={PATH:process.env.PATH,HOME:home,USERPROFILE:home,CLAUDE_CONFIG_DIR:path.join(home,'.claude'),ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.address().port}`,ANTHROPIC_API_KEY:'synthetic-local-test',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1'};
const child=spawn(process.env.OPENTAKE_TEST_CLAUDE,['-p','--resume',transcript,'--fork-session','--no-session-persistence','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--system-prompt','Synthetic test','--model','claude-sonnet-4-6','--output-format','stream-json','--verbose'],{cwd:home,env,stdio:['pipe','pipe','pipe']});
let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);const timer=setTimeout(()=>child.kill('SIGKILL'),25000);child.stdin.end('Recall the marker without any tool calls.');const code=await new Promise(r=>child.on('close',r));clearTimeout(timer);require('node:assert/strict').equal(code,0);require('node:assert/strict').ok(seen.some(messages=>messages.some(m=>m.role==='user'&&m.content.some?.(p=>p.type==='tool_result'&&p.content==='SYNTHETIC-RESULT-452'))));console.log(JSON.stringify({code,requestCount:seen.length,roles:seen.map(a=>a.map(m=>m.role)),hasToolResult:JSON.stringify(seen).includes('SYNTHETIC-RESULT-452'),completed:out.includes('Probe complete.'),error:err.slice(0,800)}));
}finally{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(home,{recursive:true,force:true});}})().catch(e=>{console.error(e.message);process.exitCode=1;});
