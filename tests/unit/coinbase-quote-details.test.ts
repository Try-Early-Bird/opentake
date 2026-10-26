import {test,expect} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {CoinbaseQuoteDetails} from '../../src/renderer/src/strategies/CoinbaseQuoteDetails';
import {CoinbaseApprovalCard} from '../../src/renderer/src/strategies/CoinbaseApprovalCard';
import type {CoinbaseOrderReview} from '../../src/shared/coinbase-orders';
const order={orderType:'market' as const,product:'BTC-USDC',side:'sell' as const,baseSize:'0.00002',limitPrice:'100.01',notional:'0.0020002',fee:'0.00001',previewId:'fixture',debits:[]};
const fixture=():CoinbaseOrderReview=>({id:'fixture',takeId:'fixture',accountLabel:'Fixture',takeTitle:'Fixture',quote:'USDC',phase:'sell',state:'confirmed',expiresAt:'2026-10-20T23:00:00Z',skipped:[],orders:[order],previousQuoteOrders:[{...order,baseSize:'0.00001',limitPrice:'100',notional:'0.001'}]});
test('quote details show compact market order and expandable precise changes',()=>{
 const html=renderToStaticMarkup(createElement(CoinbaseQuoteDetails,{review:fixture()}));
 for(const text of ['0.00001','0.00002','100.01','+0.01%','Estimated price','market','<details','text-error'])expect(html).toContain(text);
 for(const text of ['previewId','Price change:','Quote valid until','Reference price',' · fee '])expect(html).not.toContain(text);
});
test('multi asset approval displays separate sides and one Confirm and Cancel for the batch',()=>{
 const review=fixture();review.orders.push({...order,product:'ETH-USDC',side:'buy',baseSize:'1',notional:'100.01'});
 const html=renderToStaticMarkup(createElement(CoinbaseApprovalCard,{review,busy:false,onConfirm:()=>{},onCancel:()=>{},onRefresh:()=>{}}));
 for(const text of ['BTC','ETH','Sell','Buy','market','2','orders'])expect(html).toContain(text);
 expect(html.match(/>Confirm<\/button>/g)).toHaveLength(1);expect(html.match(/>Cancel<\/button>/g)).toHaveLength(1);
 expect(html).not.toContain('Skip this rebalance');expect(html).not.toContain('Confirm sell');
});
