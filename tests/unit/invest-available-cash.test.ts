import {expect,test} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {availableCashPurchase,InvestAvailableCash} from '../../src/renderer/src/strategies/InvestAvailableCash';
import {orderReviewRequest,type CoinbaseOrderReview} from '../../src/shared/coinbase-orders';
const review={state:'preview',expiresAt:new Date(2000).toISOString(),orders:[{side:'buy',notional:'2.43',fee:'0.02'}]} as CoinbaseOrderReview;
test('available cash action requires a current buy preview and includes fees',()=>{
 expect(availableCashPurchase(null,1000)).toBeNull();
 expect(availableCashPurchase(review,1000)).toBeCloseTo(2.45);
 expect(availableCashPurchase(review,2000)).toBeNull();
 expect(availableCashPurchase({...review,state:'confirmed'},1000)).toBeNull();
 expect(availableCashPurchase({...review,orders:[]},1000)).toBeNull();
 expect(availableCashPurchase({...review,orders:[{...review.orders[0],side:'sell'}]},1000)).toBeNull();
});
test('initial cash action is disabled and does not offer to retry the old deposit',()=>{
 const html=renderToStaticMarkup(createElement(InvestAvailableCash,{takeId:'test',quote:'USDC',disabled:false,onInvest:()=>{}}));
 expect(html).toContain('disabled');expect(html).toContain('Checking available cash and fees');expect(html).not.toContain('Retry investment');
});
test('purchase-only preview is accepted by the order contract',()=>{
 expect(orderReviewRequest.parse({takeId:'d8986b85-b25e-4bf2-99ef-e6f5f0440100',quote:'USDC',purchaseOnly:true}).purchaseOnly).toBe(true);
});
