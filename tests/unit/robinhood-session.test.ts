import {expect,test,vi} from 'vitest';
const state=vi.hoisted(()=>({connect:vi.fn(),close:vi.fn(async()=>{}),fail:false}));
vi.mock('@modelcontextprotocol/sdk/client/index.js',()=>({Client:class{
 connect=state.connect;
 async callTool(){if(state.fail)throw new Error('transport failed');return {structuredContent:{results:[]}};}
}}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js',()=>({StreamableHTTPClientTransport:class{close=state.close;}}));
import {LocalRobinhoodProvider} from '../../src/main/robinhood-client';
test('serial venue reads reuse the MCP session and transport errors discard it without retrying',async()=>{
 const provider=new LocalRobinhoodProvider({version:1,ownerId:'synthetic',connectionId:'synthetic',tokens:{access_token:'synthetic',token_type:'Bearer'},expiresAt:Date.now()+3600000},async()=>{});
 try{
 const read=()=>provider.readTool('get_equity_quotes',{symbols:['SPY']},undefined,new AbortController().signal);
 await read();await read();expect(state.connect).toHaveBeenCalledTimes(1);
 state.fail=true;await expect(read()).rejects.toThrow('Robinhood read failed');expect(state.close).toHaveBeenCalledTimes(1);
 state.fail=false;await read();expect(state.connect).toHaveBeenCalledTimes(2);
 }finally{state.fail=false;await provider.close();}
 expect(state.close).toHaveBeenCalledTimes(2);
});
