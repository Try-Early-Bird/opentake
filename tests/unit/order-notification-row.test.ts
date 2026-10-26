import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,test} from 'vitest';
import {OrderNotificationRow} from '../../src/renderer/src/components/OrderNotificationRow';
import type {NotificationItem} from '../../src/shared/notifications';
const render=(venue:'coinbase'|'robinhood',takeTitle:string|null='Test take',requiresAction=false)=>renderToStaticMarkup(createElement(OrderNotificationRow,{item:{title:'BTC buy · Filled',body:'Account details',occurredAt:'2026-10-12T20:00:00Z',requiresAction,resolvedAt:null,order:{venue,takeTitle,symbol:'BTC',side:'buy',execution:{state:requiresAction?'unknown':'filled',cancelState:'none'}}} as NotificationItem,onOpen:()=>{}}));
test('Coinbase and Robinhood order rows share markup and compact trading styling',()=>{
 expect(render('coinbase')).toContain('Coinbase');expect(render('robinhood')).toContain('Robinhood');
 expect(render('coinbase')).toContain('bg-[#0052ff]');expect(render('robinhood')).toContain('bg-[#ccff00]');
 const html=render('coinbase');expect(html).toContain('Test take');expect(html).toContain('BTC');expect(html).toContain('Bought');expect(html).toContain('bg-brand/10');expect(html).toContain('text-xs');expect(html).toContain('lucide-check');expect(html).not.toContain('lucide-bell');
});
test('account-only updates and unresolved orders remain readable',()=>{
 expect(render('coinbase',null)).not.toContain('Test take');
 const html=render('coinbase',null,true);expect(html).toContain('Outcome unknown');expect(html).toContain('lucide-triangle-alert');
});

import {orderNotificationTitle} from '../../src/shared/order-activity';
import type {OrderActivity} from '../../src/shared/order-activity';
test('order amounts distinguish requested value from actual fills for both venues',()=>{
 for(const venue of ['coinbase','robinhood'] as const){
  const base={venue,symbol:venue==='coinbase'?'BTC-USDC':'BTC',side:'buy',currency:'USDC',quantity:'0.1',notional:'10',filledQuantity:'0.09',filledNotional:'8.95'};
  expect(orderNotificationTitle({...base,execution:{state:'accepted'}} as OrderActivity)).toBe('Buying 0.1 BTC · $10.00 · Open');
  expect(orderNotificationTitle({...base,execution:{state:'filled'}} as OrderActivity)).toBe('Bought 0.09 BTC · $8.95');
  expect(orderNotificationTitle({...base,side:'sell',execution:{state:'filled'}} as OrderActivity)).toBe('Sold 0.09 BTC · $8.95');
  expect(orderNotificationTitle({...base,filledNotional:null,execution:{state:'filled'}} as OrderActivity)).not.toContain('$10');
 }
});

test('legacy missing market names never render null or crash for either venue',()=>{
 for(const venue of ['coinbase','robinhood'])expect(orderNotificationTitle({venue,symbol:null,side:'buy',notional:'5',execution:{state:'rejected'}} as unknown as OrderActivity)).toBe('Buying $5.00 of Unknown market · Rejected');
});
