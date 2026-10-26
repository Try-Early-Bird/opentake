import {test,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import schemas from '../fixtures/robinhood-crypto-tool-schemas-2026-10-14-followup.json';
import {createCryptoTransport} from '../../src/main/orders/crypto-transport';
import type {CryptoIntentRow} from '../../src/main/orders/crypto-journal';
const account={account_number:'synthetic-account',rhs_account_number:'123456',rhc_account_number:'RHC-fake',agentic_allowed:true,type:'cash',brokerage_account_type:'individual',state:'active',deactivated:false,permanently_deactivated:false};
const externalRef=createHash('sha256').update(account.account_number).digest('hex');
const pair={id:'pair-btc',symbol:'BTC-USD',asset_currency:{code:'BTC'},quote_currency:{code:'USD'},tradability:'tradable',display_only:false,min_order_size:'0.00001',max_order_size:'10',min_order_quantity_increment:'0.00001',min_order_price_increment:'0.01',min_order_quote_amount:'1',market_orders_only:false,halted:false};
const order={currency_pair_id:pair.id,side:'buy' as const,type:'limit' as const,dollar_amount:'5',limit_price:'50000',time_in_force:'gtc' as const};
function fixture(){
 let wrongEcho=false;const controller=new AbortController();
 const read=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='get_accounts')return {data:{accounts:[account]}};
  if(name==='get_currency_pairs')return {data:{results:[pair]}};
  if(name==='preview_crypto_order')return {data:{crypto_account_number:account.rhc_account_number,order:{currency_pair_id:pair.id,side:'buy',type:'limit',time_in_force:'gtc',quantity:'0.0001',limit_price:'50000',net_rounded_estimated_notional:'5'},estimated_fee:'0',customer_approval_required:true}};
  if(name==='get_crypto_orders')return {data:{rhs_account_number:wrongEcho?'other':account.rhs_account_number,results:[]}};
  if(name==='get_trade_approvals')return {data:{approvals:[{approval_id:'approval'}]}};
  throw Error(name);
 });
 const write=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  const validate=new Ajv({strict:false}).compile(schemas.tools.find(t=>t.name===name)!.inputSchema);
  expect(validate(args),JSON.stringify(validate.errors)).toBe(true);
  return {isError:false,errorCategory:null,data:{data:{accepted:true}}};
 });
 const session=createCryptoTransport(read,write,externalRef,'local-account',controller.signal);
 const intent={id:randomUUID(),account_id:'local-account',ref_id:randomUUID(),order_request:order,review_result:{symbol:'BTC-USD'},approval_ref:'approval',status:'placed',provider_order_ref:randomUUID()} as CryptoIntentRow;
 return {session,read,write,intent,controller,wrong:()=>{wrongEcho=true;}};
}
test('transport reuses eligibility, caps limit-dollar debit and sends the original ref exactly once',async()=>{
 const f=fixture();expect(await f.session.review(order)).toMatchObject({maximumDebit:'5.01',preview:{symbol:'BTC-USD'}});
 expect(f.write).not.toHaveBeenCalled();const prepared=await f.session.prepare(f.intent);
 expect(prepared.maximumDebit).toBe('5.01');await prepared.send();
 expect(f.write).toHaveBeenCalledWith('place_crypto_order',{symbol:'BTC-USD',rhs_account_number:account.rhs_account_number,side:'buy',type:'limit',dollar_amount:'5',limit_price:'50000',time_in_force:'gtc',ref_id:f.intent.ref_id},expect.any(AbortSignal));
 await expect(prepared.send()).rejects.toThrow('already attempted');expect(f.write).toHaveBeenCalledTimes(1);
});
test('unsupported execution sizing and changed identity refuse before a write',async()=>{
 const f=fixture();
 for(const raw of [{...order,side:'sell'},{...order,dollar_amount:undefined,quantity:'0.0001'}])await expect(f.session.review(raw)).rejects.toThrow();
 await expect(f.session.prepare({...f.intent,account_id:'other'})).rejects.toThrow('account changed');
 await expect(f.session.prepare({...f.intent,review_result:{symbol:'BCH-USD'}})).rejects.toThrow('symbol changed');expect(f.write).not.toHaveBeenCalled();
});
test('observation checks account echo and reads approvals using the captured approvals envelope',async()=>{
 const f=fixture();expect(await f.session.observe(f.intent)).toMatchObject({read:{complete:true,orders:[],approvals:[{approval_id:'approval'}]}});
 expect(f.read).toHaveBeenCalledWith('get_trade_approvals',{account_number:account.account_number,approval_ids:['approval']},expect.any(AbortSignal));
 f.wrong();await expect(f.session.observe(f.intent)).rejects.toThrow();expect(f.write).not.toHaveBeenCalled();
});
test('cancellation binds the stored order and aborted preparation never submits',async()=>{
 const f=fixture();await f.session.cancel(f.intent);expect(f.write).toHaveBeenCalledWith('cancel_crypto_order',{rhs_account_number:account.rhs_account_number,order_id:f.intent.provider_order_ref},expect.any(AbortSignal));
 const prepared=await f.session.prepare(f.intent);f.controller.abort();await expect(prepared.send()).rejects.toThrow();expect(f.write).toHaveBeenCalledTimes(1);
});


test('market buy reserves collar plus rounding and unit sell carries fresh availability without changing sizing',async()=>{
 const f=fixture();
 f.read.mockImplementation(async(name)=>{
  if(name==='get_accounts')return {data:{accounts:[account]}} as any;
  if(name==='get_currency_pairs')return {data:{results:[pair]}};
  if(name==='get_crypto_positions')return {data:{results:[{currency_pair_id:pair.id,quantity_transferable:'0.001'}]}};
  return {data:{order:{currency_pair_id:pair.id,side:side,type:'market',time_in_force:'gtc',quantity:'0.0001',price:'50000',net_rounded_estimated_notional:'5'},estimated_fee:'0'}} as any;
 });
 let side='buy';
 const buy={currency_pair_id:pair.id,side:'buy',type:'market',dollar_amount:'5',time_in_force:'gtc'};
 expect(await f.session.review(buy)).toMatchObject({maximumDebit:'5.06'});
 const ready=await f.session.prepare({...f.intent,order_request:buy as any});await ready.send();
 expect(f.write.mock.calls[0][1]).toMatchObject({type:'market',dollar_amount:'5'});expect(f.write.mock.calls[0][1]).not.toHaveProperty('limit_price');
 side='sell';const sell={currency_pair_id:pair.id,side:'sell',type:'market',quantity:'0.0001'};
 const prepared=await f.session.prepare({...f.intent,order_request:sell as any});
 expect(prepared.maximumDebit).toBe('0');expect(prepared.sellAvailability?.quantity).toBe('0.001');
 await prepared.send();expect(f.write.mock.calls[1][1]).toMatchObject({side:'sell',type:'market',quantity:'0.0001'});expect(f.write.mock.calls[1][1]).not.toHaveProperty('dollar_amount');
});

test('portfolio discovers existing holdings with no Take targets or saved orders',async()=>{
 const f=fixture();
 f.read.mockImplementation(async(name,args)=>{
  if(name==='get_accounts')return {data:{accounts:[account]}} as any;
  if(name==='get_crypto_positions'){
   expect(args).toEqual({rhs_account_number:account.rhs_account_number});
   return {data:{results:[{currency_pair_id:pair.id,currency:{code:'BTC',type:'cryptocurrency'},quantity:'0.002',quantity_transferable:'0.002',quantity_held_for_sell:'0'}]}} as any;
  }
  if(name==='get_currency_pairs')return {data:{results:[pair]}} as any;
  expect(name).toBe('get_crypto_quotes');
  return {data:{results:[{id:pair.id,symbol:'BTCUSD',mark_price:'50000',bid_price:'49999',ask_price:'50001',updated_at:new Date().toISOString()}]}} as any;
 });
 expect(await f.session.portfolio([])).toMatchObject([{symbol:'BTC-USD',quantity:'0.002',marketValue:'100'}]);
 expect(f.write).not.toHaveBeenCalled();
});

test('portfolio rechecks crypto linkage each sync and skips catalog/quotes when there are no assets',async()=>{
 const f=fixture();let linked=false;
 f.read.mockImplementation(async(name)=>{
  if(name==='get_accounts')return {data:{accounts:[{...account,rhc_account_number:linked?account.rhc_account_number:''}]}} as any;
  expect(name).toBe('get_crypto_positions');return {data:{results:[]}} as any;
 });
 expect(await f.session.portfolio([])).toEqual([]);
 expect(f.read.mock.calls.map(c=>c[0])).toEqual(['get_accounts']);
 linked=true;
 expect(await f.session.portfolio([])).toEqual([]);
 expect(f.read.mock.calls.map(c=>c[0])).toEqual(['get_accounts','get_accounts','get_crypto_positions']);
 expect(f.write).not.toHaveBeenCalled();
});

test('portfolio failures never masquerade as confirmed empty holdings',async()=>{
 const f=fixture();
 for(const accounts of [[],[account,account],[{...account,rhc_account_number:undefined}],[{...account,agentic_allowed:false}]]){
  f.read.mockResolvedValue({data:{accounts}} as any);
  await expect(f.session.portfolio([])).rejects.toThrow();
 }
 f.read.mockRejectedValue(new Error('offline'));
 await expect(f.session.portfolio([])).rejects.toThrow('offline');
 f.read.mockImplementation(async(name)=>{
  if(name==='get_accounts')return {data:{accounts:[account]}} as any;
  throw new Error('positions unavailable');
 });
 await expect(f.session.portfolio([])).rejects.toThrow('positions unavailable');
 expect(f.write).not.toHaveBeenCalled();
});
