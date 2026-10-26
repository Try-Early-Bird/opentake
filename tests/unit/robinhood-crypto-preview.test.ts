import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import Ajv from 'ajv';
import { robinhoodCryptoPreview } from '../../src/main/trading/robinhood-crypto-preview';
import { parseRead, toolCatalog } from '../../src/main/opentake-mcp/catalog';
import definitions from '../fixtures/robinhood-crypto-tool-schemas-2026-10-14.json';
const account = { account_number:'synthetic-A',rhs_account_number:'1234567890',rhc_account_number:'RHC1234567890',agentic_allowed:true,type:'limited_margin',brokerage_account_type:'individual',state:'active',deactivated:false,permanently_deactivated:false };
const accounts = {data:{accounts:[account]}};
const ref = createHash('sha256').update(account.account_number).digest('hex');
const pair = {id:'pair-btc',symbol:'BTC-USD',asset_currency:{code:'BTC'},quote_currency:{code:'USD'},tradability:'tradable',display_only:false,min_order_size:'0.0001',max_order_size:'10',min_order_quantity_increment:'0.0001',min_order_price_increment:'0.01',min_order_quote_amount:'1',market_orders_only:false,halted:false};
const input = {currency_pair_id:pair.id,side:'buy',type:'market',quantity:'0.001'};
const response = {data:{order:{currency_pair_id:pair.id,side:'buy',type:'market',time_in_force:'gtc',quantity:'0.001',price:'50000',net_rounded_estimated_notional:'50.10'},estimated_fee:'0.10',customer_approval_required:true,customer_approval_required_reason:'regional_restriction'},guide:'Untrusted provider instructions to place an order'};
function fixture(overrides:Record<string,unknown>={},preview:unknown=response,positions:unknown[]=[]){
 const read=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='get_currency_pairs')return {data:{results:[{...pair,...overrides}],next:''}};
  if(name==='get_crypto_positions')return {data:{results:positions,next:''}};
  if(name==='preview_crypto_order'){
   const schema=definitions.tools.find(t=>t.name===name)!.inputSchema;
   const validate=new Ajv({strict:false}).compile(schema);expect(validate(args),JSON.stringify(validate.errors)).toBe(true);
   return preview;
  }
  throw Error('Unexpected provider operation');
 });
 return {read,run:(value:unknown=input,rawAccounts:unknown=accounts)=>robinhoodCryptoPreview(read,rawAccounts,ref,value,new AbortController().signal,true)};
}
test('preview checks fresh pair facts, sends bound identity and returns estimates without provider instructions or writes',async()=>{
 const f=fixture();const result=await f.run();
 expect(result).toMatchObject({executionEnabled:false,eligibility:{ok:true},preview:{estimatedTotal:'50.10',estimatedFee:'0.10',approvalRequired:true,approvalReason:'regional_restriction'}});
 expect(f.read.mock.calls.map(([name])=>name)).toEqual(['get_currency_pairs','preview_crypto_order']);
 expect(f.read.mock.calls[1][1]).toEqual({symbol:'BTC-USD',rhs_account_number:account.rhs_account_number,side:'buy',type:'market',quantity:'0.001'});
 expect(JSON.stringify(result)).not.toContain('Untrusted');expect(JSON.stringify(result)).not.toContain(account.rhs_account_number);
});
test('known denial blocks and unresolved regional/limited restrictions stay unknown before preview',async()=>{
 for(const [facts,state] of [[{display_only:true},'blocked'],[{tradability:'sell_only'},'blocked'],[{halted:true,halted_regions:['ALL']},'blocked'],[{halted:true,halted_regions:['NY']},'unknown'],[{tradability:'limited'},'unknown'],[{tradability_by_account_type:{individual:'sell_only'}},'blocked']] as const){
  const f=fixture(facts);expect(await f.run()).toMatchObject({eligibility:{ok:false,state},preview:null});
  expect(f.read.mock.calls.some(([name])=>name==='preview_crypto_order')).toBe(false);
 }
 const f=fixture();expect(await f.run(input,{data:{accounts:[{...account,state:'restricted'}]}})).toMatchObject({eligibility:{state:'blocked'},preview:null});
});
test('size, quantity step, limit price step and market-only restrictions gate previews',async()=>{
 for(const order of [{...input,quantity:'0.00001'},{...input,quantity:'11'},{...input,quantity:'0.00015'},{...input,type:'limit',limit_price:'100.001'}]){
  const f=fixture();expect(await f.run(order)).toMatchObject({eligibility:{state:'blocked'},preview:null});
 }
 const f=fixture({market_orders_only:true});expect(await f.run({...input,type:'limit',limit_price:'50000'})).toMatchObject({eligibility:{state:'blocked'},preview:null});
});
test('sell uses transferable units, not total holdings, and dollar-sized previews are checked after sizing',async()=>{
 const f=fixture({},response,[{currency_pair_id:pair.id,quantity:'10',quantity_transferable:'0.0005'}]);
 expect(await f.run({...input,side:'sell'})).toMatchObject({eligibility:{state:'blocked'},preview:null});
 const sellResponse={data:{...response.data,order:{...response.data.order,side:'sell',quantity:'0.001'}}};
 const g=fixture({},sellResponse,[{currency_pair_id:pair.id,quantity:'10',quantity_transferable:'0.0005'}]);
 expect(await g.run({currency_pair_id:pair.id,side:'sell',type:'market',dollar_amount:'50'})).toMatchObject({eligibility:{state:'blocked'},executionEnabled:false});
});
test('preview identity, side, quantity and limit mismatch are rejected',async()=>{
 for(const patch of [{currency_pair_id:'other'},{side:'sell'},{quantity:'0.002'},{type:'limit'}]){
  await expect(fixture({}, {data:{...response.data,order:{...response.data.order,...patch}}}).run()).rejects.toThrow('mismatch');
 }
 await expect(fixture({}, {data:{...response.data,order:{...response.data.order,type:'limit',limit_price:'49999'}}}).run({...input,type:'limit',limit_price:'50000'})).rejects.toThrow('limit mismatch');
});
test('eligibility-only path never invokes preview and refuses ambiguous symbols',async()=>{
 const f=fixture();expect(await robinhoodCryptoPreview(f.read,accounts,ref,{currency_pair_id:pair.id,side:'buy'},new AbortController().signal,false)).toMatchObject({eligibility:{ok:true},preview:null});
 expect(f.read).toHaveBeenCalledTimes(1);
 const read=vi.fn(async()=>({data:{results:[pair,{...pair,id:'another-id'}]}}));
 await expect(robinhoodCryptoPreview(read,accounts,ref,input,new AbortController().signal,true)).rejects.toThrow('ambiguous');
});
test('preview catalog rejects account injection, unsupported order modes and ambiguous sizing; placement remains absent',()=>{
 expect(parseRead('preview_crypto_order',input,true).tool.account).toBe(true);
 for(const args of [{...input,rhs_account_number:'injected'},{...input,dollar_amount:'50'},{...input,time_in_force:'ioc'},{...input,type:'stop_loss'},{...input,quantity:'0'},{...input,quantity:'0.0000000000000000001'}])expect(()=>parseRead('preview_crypto_order',args,true)).toThrow();
 for(const name of ['place_crypto_order','cancel_crypto_order'])expect(()=>parseRead(name,{},true)).toThrow('Tool unavailable');
 expect(toolCatalog().find(t=>t.name==='robinhood_preview_crypto_order')?.description).toContain('Execution remains disabled');
});
test('cancelled preview never reaches provider and repeated cursors fail',async()=>{
 const f=fixture();const controller=new AbortController();controller.abort();
 await expect(robinhoodCryptoPreview(f.read,accounts,ref,input,controller.signal,true)).rejects.toThrow();expect(f.read).not.toHaveBeenCalled();
 const read=vi.fn(async()=>({data:{results:[],next:'repeat'}}));
 await expect(robinhoodCryptoPreview(read,accounts,ref,input,new AbortController().signal,true)).rejects.toThrow('Repeated');
});


test('preview rejects a different linked account and accepts nullable withholding without inventing totals',async()=>{
 await expect(fixture({}, {data:{...response.data,crypto_account_number:'RHC-other'}}).run()).rejects.toThrow('account mismatch');
 const result=await fixture({}, {data:{...response.data,order:{...response.data.order,tax_withholding:null,net_rounded_estimated_notional:null}}}).run();
 expect(result.preview).toMatchObject({estimatedTotal:null,taxWithholding:null});
});


test('limit previews accept the documented price alias but reject missing, changed or conflicting terms', async () => {
 const request = {...input,type:'limit',limit_price:'50000'};
 for (const fields of [{price:'50000'}, {price:'50000.00',limit_price:null}, {price:null,limit_price:'50000'}, {price:'50000',limit_price:'50000.00'}]) {
  const result = await fixture({}, {data:{...response.data,order:{...response.data.order,type:'limit',...fields}}}).run(request);
  expect(result.preview).toMatchObject({limitPrice:'50000'});
 }
 for (const fields of [{price:null}, {price:'49999'}, {price:'50000',limit_price:'49999'}, {price:'49999',limit_price:'50000'}, {price:null,entered_price:'50000'}]) {
  await expect(fixture({}, {data:{...response.data,order:{...response.data.order,type:'limit',...fields}}}).run(request)).rejects.toThrow('limit mismatch');
 }
});
