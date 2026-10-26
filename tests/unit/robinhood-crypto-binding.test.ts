import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import Ajv from 'ajv';
import definitions from '../fixtures/robinhood-crypto-tool-schemas-2026-10-14-followup.json';
import { bindRobinhoodCryptoAccount } from '../../src/main/robinhood-account-binding';
import { parseRead } from '../../src/main/opentake-mcp/catalog';
const state = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: class { connect = async () => {}; callTool = state.call; } }));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: class { close = async () => {}; } }));
import { LocalRobinhoodProvider } from '../../src/main/robinhood-client';
const account = { account_number: 'synthetic-account-A', rhs_account_number: '1234567890', rhc_account_number: 'RHC9876543210', agentic_allowed: true, type: 'limited_margin', brokerage_account_type: 'individual', state: 'active', deactivated: false, permanently_deactivated: false, is_default: true, option_level: 'option_level_0' };
const ref = createHash('sha256').update(account.account_number).digest('hex');
const payload = (accounts: unknown[]) => ({ data: { accounts }, guide: '' });
test('crypto binding preserves selected same-row IDs and distinct account category/trading type', () => {
 const raw = payload([{...account,account_number:'other',rhs_account_number:'2222222222'},account]);
 const validate = new Ajv({strict:false}).compile(definitions.tools.find(t=>t.name==='get_accounts')!.outputSchema);
 expect(validate(raw),JSON.stringify(validate.errors)).toBe(true);
 expect(bindRobinhoodCryptoAccount(raw,ref)).toMatchObject({rhsAccountNumber:account.rhs_account_number,brokerageAccountType:'individual',tradingType:'limited_margin'});
});
test('missing, duplicate, inaccessible and malformed account bindings fail closed', () => {
 for (const rows of [[],[account,account],[{...account,agentic_allowed:false}],[{...account,rhc_account_number:''}],[{...account,rhs_account_number:'RHC123'}],[{...account,account_number:'other'}]]) {
  expect(()=>bindRobinhoodCryptoAccount(payload(rows),ref)).toThrow();
 }
 expect(()=>bindRobinhoodCryptoAccount(payload([account]),undefined)).toThrow();
});
test('crypto read inputs match provider schemas after host-injected identity and reject raw identity injection',()=>{
 const ajv = new Ajv({strict:false});
 for(const name of ['get_crypto_positions','get_crypto_orders']) {
  const parsed=parseRead(name,{},true);expect(parsed.tool.accountField).toBe('rhs_account_number');
  expect(ajv.compile(definitions.tools.find(t=>t.name===name)!.inputSchema)({...parsed.args,rhs_account_number:account.rhs_account_number})).toBe(true);
  for(const field of ['rhs_account_number','account_number','rhc_account_number'])expect(()=>parseRead(name,{[field]:'injected'},true)).toThrow();
 }
 expect(()=>parseRead('get_crypto_orders',{state:'filled',state_group:'closed'},true)).toThrow();
});
test('transport refreshes account binding, injects RHS and redacts linked account identifiers', async () => {
 state.call.mockReset();
 let allowed=true;
 state.call.mockImplementation(async ({name,arguments:args})=>{
  if(name==='get_accounts')return {structuredContent:payload([{...account,agentic_allowed:allowed}])};
  expect(name).toBe('get_crypto_positions');expect(args).toEqual({rhs_account_number:account.rhs_account_number});
  return {structuredContent:{data:{crypto_account_number:account.rhc_account_number,results:[],note:account.account_number+' '+account.rhs_account_number+' '+account.rhc_account_number}}};
 });
 const provider=new LocalRobinhoodProvider({version:1,ownerId:'synthetic',connectionId:'synthetic',tokens:{access_token:'synthetic',token_type:'Bearer'},expiresAt:Date.now()+3600000},async()=>{});
 try {
  const result=JSON.stringify(await provider.readTool('get_crypto_positions',{},ref,new AbortController().signal));
  for(const value of [account.account_number,account.rhs_account_number,account.rhc_account_number])expect(result).not.toContain(value);
  allowed=false;
  await expect(provider.readTool('get_crypto_positions',{},ref,new AbortController().signal)).rejects.toThrow('Crypto account unavailable');
  expect(state.call.mock.calls.map(([request])=>request.name)).toEqual(['get_accounts','get_crypto_positions','get_accounts']);
 } finally { await provider.close(); }
});

test('crypto write transport keeps text error details even when structured content exists',async()=>{
 state.call.mockReset();
 state.call.mockImplementation(async({name})=>name==='get_accounts'?{structuredContent:payload([account])}:{isError:true,_meta:{rh_error_category:'invalid_request'},structuredContent:{data:{}},content:[{type:'text',text:'Order quantity has unexpected precision'}]});
 const provider=new LocalRobinhoodProvider({version:1,ownerId:'synthetic',connectionId:'synthetic',tokens:{access_token:'synthetic',token_type:'Bearer'},expiresAt:Date.now()+3600000},async()=>{});
 try{
  const result=await provider.cryptoSession(ref,'local-account',new AbortController().signal,session=>session.cancel({account_id:'local-account',status:'placed',provider_order_ref:'synthetic-order'} as any));
  expect(result).toMatchObject({isError:true,errorCategory:'invalid_request',data:{data:{}},errorDetails:{errors:[{data:{}},'Order quantity has unexpected precision']}});
 }finally{await provider.close();}
});
