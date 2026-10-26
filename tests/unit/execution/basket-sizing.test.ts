import {expect,test} from 'vitest';
import {sizeTargetBasket,affordableBuy,type SizingPolicy} from '../../../src/main/planning/basket-sizing';
import {cryptoBuyMaximumDebit} from '../../../src/main/orders/crypto-transport';
import {decimalToScaledInteger as amount} from '../../../src/main/allocations/decimal';
import {marketKey} from '../../../src/shared/search';
const btc=marketKey({identity:{venue:'robinhood',instance:'production',reference:'btc',kind:'crypto'}});
const eth=marketKey({identity:{venue:'robinhood',instance:'production',reference:'eth',kind:'crypto'}});
const debit=(n:string)=>cryptoBuyMaximumDebit(n,'market');
const policy:SizingPolicy={quantityIncrement:'0.00000001',minimumOrderNotionalUsd:'1',maximumBuyDebit:debit};
const leg=(symbol:string,weight=50)=>({symbol,targetWeightPercent:weight,allocationValueUsd:'100',currentInstrumentValueUsd:'0',currentQuantity:'0',availableCashUsd:'100',markPriceUsd:'90000',maximumOrderNotionalUsd:'100',minimumOrderNotionalUsd:'1',sellMinimumHeadroomBps:500});
test('all first-purchase legs share reserve headroom without spending the last legs cash',()=>{
 const result=sizeTargetBasket({legs:[leg(btc),leg(eth)],policies:new Map([[btc,policy],[eth,policy]]),cashUsd:'100',firstPurchase:true,buysOnly:false,sellProceedsHaircutBps:100});
 expect(result.deferred).toBeNull();expect(result.orders).toHaveLength(2);
 const buys=result.orders.filter(o=>o.side==='buy');
 expect(buys[0].dollarAmount).toBe(buys[1].dollarAmount);
 expect(buys.reduce((sum,o)=>sum+amount(debit(o.dollarAmount)),0n)).toBeLessThanOrEqual(amount('100'));
 expect(result.orders.map(o=>o.symbol)).toEqual([btc,eth]);
});
test('later buys cap against full debit, and same ticker equity/crypto keys stay separate',()=>{
 const result=sizeTargetBasket({legs:[leg('BTC'),leg(btc)],policies:new Map([[btc,policy]]),cashUsd:'100',firstPurchase:false,buysOnly:true,sellProceedsHaircutBps:100});
 expect(result.orders).toHaveLength(2);
 expect(result.orders[0]).toMatchObject({symbol:'BTC',dollarAmount:'50'});
 const buy=result.orders[1];expect(buy.side).toBe('buy');if(buy.side==='buy')expect(amount(debit(buy.dollarAmount))).toBeLessThanOrEqual(amount('50'));
});
test('crypto sells retain provider precision and enforce provider maximum',()=>{
 const sell={...leg(btc,0),currentInstrumentValueUsd:'90',currentQuantity:'0.00100001',markPriceUsd:'90000'};
 const result=sizeTargetBasket({legs:[sell],policies:new Map([[btc,policy]]),cashUsd:'0',firstPurchase:false,buysOnly:false,sellProceedsHaircutBps:100});
 expect(result.orders[0]).toMatchObject({side:'sell',quantity:'0.00100001'});
 expect(sizeTargetBasket({legs:[sell],policies:new Map([[btc,{...policy,maximumOrderNotionalUsd:'50'}]]),cashUsd:'0',firstPurchase:false,buysOnly:false,sellProceedsHaircutBps:100}).deferred).toBe('order_notional_limit');
});
test('affordable dollar buys include cent rounding at small budgets',()=>{
 for(const cash of ['0','0.01','1','5','100','123.45']){
  const n=affordableBuy(cash,debit);
  if(n!=='0')expect(amount(debit(n))).toBeLessThanOrEqual(amount(cash));
 }
 expect(affordableBuy('5',debit)).toBe('4.94');
});
