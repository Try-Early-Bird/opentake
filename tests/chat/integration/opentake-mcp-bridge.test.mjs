import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('built bridge uses the run gateway and rejects calls after capability revocation', async () => {
  const token='a'.repeat(64);const run=randomUUID();const calls=[];let active=true;
  const definition={name:'opentake_connection_status',description:'Synthetic connection check',inputSchema:{type:'object',properties:{platform:{type:'string'}}}};
  const accountRef=randomUUID();
  const coinbase={name:'coinbase_products_get',description:'Synthetic Coinbase market read',inputSchema:{type:'object',properties:{accountRef:{type:'string',format:'uuid'},product_id:{type:'string'}},required:['accountRef','product_id'],additionalProperties:false}};
  const host=createServer(async(req,res)=>{
    if(!active||req.url!=='/rpc'||req.headers.authorization!==`Bearer ${token}`){res.writeHead(403).end();return;}
    let body='';for await(const chunk of req)body+=chunk;
    const call=JSON.parse(body);
    if(call.args[0]!==run||!['gateway:instructions','gateway:list','gateway:call'].includes(call.method)){res.writeHead(403).end();return;}
    calls.push(call);
    const value=call.method==='gateway:instructions'?'Synthetic MCP guidance, revision 7':call.method==='gateway:list'?[definition,coinbase]:{content:[{type:'text',text:'Synthetic account connected'}]};
    res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,value}));
  });
  await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));
  const client=new Client({name:'synthetic',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[resolve('out/main/earlybird-opentake-mcp.js'),'--run',run],env:{OPENTAKE_GATEWAY_TOKEN:token,OPENTAKE_GATEWAY_PORT:String(host.address().port)},stderr:'pipe'});
  try{
    await client.connect(transport);
    assert.equal(client.getInstructions(),'Synthetic MCP guidance, revision 7');
    assert.deepEqual((await client.listTools()).tools,[definition,coinbase]);
    const result=await client.callTool({name:definition.name,arguments:{platform:'robinhood'}});
    assert.equal(result.isError,undefined);
    assert.deepEqual(calls.at(-1).args,[run,definition.name,{platform:'robinhood'}]);
    assert.equal(calls.at(-1).method,'gateway:call');
    assert.equal((await client.callTool({name:coinbase.name,arguments:{accountRef,product_id:'BTC-USD'}})).isError,undefined);
    assert.deepEqual(calls.at(-1).args,[run,coinbase.name,{accountRef,product_id:'BTC-USD'}]);
    active=false;
    assert.equal((await client.callTool({name:definition.name,arguments:{platform:'robinhood'}})).isError,true);
    assert.equal(calls.length,4);
  }finally{await client.close();await transport.close();await new Promise(resolve=>host.close(resolve));}
});
