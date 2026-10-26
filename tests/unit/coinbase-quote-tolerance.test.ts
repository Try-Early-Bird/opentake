import {test,expect} from 'vitest';
import {quoteNeedsReconfirmation} from '../../src/main/coinbase/quote-tolerance';
import type {CoinbaseOrderReview} from '../../src/shared/coinbase-orders';
const review=():CoinbaseOrderReview=>({id:'fixture',takeId:'fixture',accountLabel:'Fixture',takeTitle:'Fixture',quote:'USD',phase:'sell',state:'confirmed',expiresAt:'2026-10-20T23:00:00Z',skipped:[],orders:[{orderType:'market',product:'BTC-USD',side:'sell',baseSize:'1',limitPrice:'100',notional:'100',fee:'1',previewId:'fixture',debits:[{asset:'BTC',quantity:'1'}]}]});
test('quote tolerance accepts the exact boundary and rejects moves beyond it in either direction',()=>{
 for(const [price,expected] of [['100.5',false],['99.5',false],['100.50000001',true],['99.49999999',true]] as const){const old=review(),next=review();next.orders[0].limitPrice=price;expect(quoteNeedsReconfirmation(old,next)).toBe(expected);}
});
test('quote tolerance independently bounds sizing, value, fees and reserved funds',()=>{
 for(const field of ['baseSize','fee','debit'] as const){const old=review(),next=review();if(field==='debit')next.orders[0].debits[0].quantity='1.006';else next.orders[0][field]=field==='baseSize'?'1.006':field==='fee'?'1.51':'100.6';expect(quoteNeedsReconfirmation(old,next)).toBe(true);}
 const old=review(),next=review();next.orders[0].fee='1.01';expect(quoteNeedsReconfirmation(old,next)).toBe(false);
});
test('quote tolerance never permits different markets, sides, order types or debit assets',()=>{
 for(const field of ['product','side','orderType','asset','count'] as const){const old=review(),next=review();if(field==='product')next.orders[0].product='ETH-USD';if(field==='side')next.orders[0].side='buy';if(field==='orderType')next.orders[0].orderType='limit';if(field==='asset')next.orders[0].debits[0].asset='ETH';if(field==='count')next.orders=[];expect(quoteNeedsReconfirmation(old,next)).toBe(true);}
});

test('base-sized sells ignore penny rounding but keep exact economic bounds',()=>{
 const old=review(),next=review();
 Object.assign(old.orders[0],{baseSize:'0.00002328',limitPrice:'82834.84',notional:'1.93',fee:'0.01735526',debits:[{asset:'BTC',quantity:'0.00002328'}]});
 Object.assign(next.orders[0],{baseSize:'0.00002329',limitPrice:'83060.15',notional:'1.94',fee:'0.01741031',debits:[{asset:'BTC',quantity:'0.00002329'}]});
 expect(quoteNeedsReconfirmation(old,next)).toBe(false);expect(quoteNeedsReconfirmation(next,old)).toBe(false);
 next.orders[0].limitPrice='84000';expect(quoteNeedsReconfirmation(old,next)).toBe(true);
});
test('quote-sized buys still guard the actual submitted cash amount',()=>{
 const old=review(),next=review();old.orders[0].side='buy';next.orders[0].side='buy';
 next.orders[0].notional='100.51';expect(quoteNeedsReconfirmation(old,next)).toBe(true);
});
test('combined base-sized quantity and price changes cannot exceed tolerance',()=>{
 const old=review(),next=review();next.orders[0].baseSize='1.003';next.orders[0].limitPrice='100.3';
 expect(quoteNeedsReconfirmation(old,next)).toBe(true);
});
