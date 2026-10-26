import {expect,test} from 'vitest';
import {coinbaseFillMovements,reconcileCurrencyClaims,previewCurrencyReservation,applyAllocationFill,type CurrencyClaim} from '../../src/main/coinbase/currency-accounting';
import type {CoinbaseFill} from '../../src/main/coinbase/activity';
const fill:CoinbaseFill={providerExecutionRef:'fill',tradeRef:'trade',orderRef:'order',productId:'BTC-USDC',instrumentRef:'coinbase:BTC',symbol:'BTC',currency:'USDC',side:'buy',quantity:'0.002',price:'50000',notionalAmount:'100',feeAmount:'0.1',feeCurrency:'USDC',commissionTotal:null,sourceSize:'100',sizeInQuote:true,occurredAt:'2026-10-10T00:00:00Z',sequenceAt:'2026-10-10T00:00:00Z',assetClass:'crypto',origin:'unknown'};
const claim=(allocationId:string,asset:string,quantity:string,reserved='0'):CurrencyClaim=>({accountId:'account',allocationId,asset,quantity,reserved});
test('buy and sell preserve independent base, quote and fee legs',()=>{
 expect(coinbaseFillMovements(fill)).toEqual([{asset:'BTC',kind:'base',quantity:'0.002',exact:true},{asset:'USDC',kind:'quote',quantity:'-100',exact:true},{asset:'USDC',kind:'fee',quantity:'-0.1',exact:true}]);
 expect(coinbaseFillMovements({...fill,side:'sell'}).map(m=>m.quantity)).toEqual(['-0.002','100','-0.1']);
 expect(coinbaseFillMovements({...fill,feeCurrency:'ETH',feeAmount:'0.00001'})[2]).toMatchObject({asset:'ETH',quantity:'-0.00001'});
});
test('repeating conversions are marked inexact and cannot become allocation claims',()=>{
 const repeating={...fill,price:'3',sourceSize:'1',quantity:'0.'+'3'.repeat(36),notionalAmount:'1'};
 expect(coinbaseFillMovements(repeating)[0].exact).toBe(false);
 expect(()=>applyAllocationFill('account','take-a','account',repeating,[claim('take-a','USDC','100')])).toThrow('Exact');
 expect(()=>coinbaseFillMovements({...fill,currency:'USD'})).toThrow();
 expect(()=>coinbaseFillMovements({...fill,notionalAmount:'101'})).toThrow();
});
test('two Takes share an account without mixing USD, USDC, reserved funds or other accounts',()=>{
 const balances=[{asset:'USD',total:'1000',available:'1000'},{asset:'USDC',total:'300',available:'250'}];
 const claims=[claim('take-a','USDC','100','10'),claim('take-b','USDC','150','25')];
 const rows=reconcileCurrencyClaims('account',balances,claims);
 expect(rows.find(r=>r.asset==='USD')).toMatchObject({claimed:'0',unclaimed:'1000'});
 expect(rows.find(r=>r.asset==='USDC')).toMatchObject({claimed:'250',reserved:'35',unclaimed:'0',state:'reconciled'});
 expect(previewCurrencyReservation('account','take-a','USDC','90',balances,claims).reserved).toBe('100');
 expect(()=>previewCurrencyReservation('account','take-a','USDC','91',balances,claims)).toThrow();
 expect(()=>previewCurrencyReservation('account','take-a','USD','1',balances,claims)).toThrow();
 expect(()=>reconcileCurrencyClaims('other-account',balances,claims)).toThrow();
});
test('missing holdings, external withdrawals and unavailable balances block reservations',()=>{
 const claims=[claim('take-a','USDC','100')];
 expect(reconcileCurrencyClaims('account',[],claims)[0].state).toBe('missing');
 const balances=[{asset:'USDC',total:'90',available:'90'}];
 expect(reconcileCurrencyClaims('account',balances,claims)[0]).toMatchObject({state:'shortfall',shortfall:'10'});
 expect(()=>previewCurrencyReservation('account','take-a','USDC','1',balances,claims)).toThrow();
 expect(()=>previewCurrencyReservation('account','take-a','USDC','1',[{asset:'USDC',total:'100',available:null}],claims)).toThrow();
});
test('explicit allocation fill affects only that Take and charges its actual fee currency',()=>{
 const original=[claim('take-a','USDC','200'),claim('take-b','USDC','100')];
 const next=applyAllocationFill('account','take-a','account',fill,original);
 expect(next.find(c=>c.allocationId==='take-a'&&c.asset==='USDC')?.quantity).toBe('99.9');
 expect(next.find(c=>c.allocationId==='take-a'&&c.asset==='BTC')?.quantity).toBe('0.002');
 expect(next.find(c=>c.allocationId==='take-b')?.quantity).toBe('100');expect(original[0].quantity).toBe('200');
 expect(()=>applyAllocationFill('account','take-a','other',fill,original)).toThrow();
 expect(()=>applyAllocationFill('account','take-a','account',{...fill,side:'sell'},original)).toThrow();
});
