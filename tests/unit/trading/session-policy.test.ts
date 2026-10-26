import {describe,expect,test} from 'vitest';
import {tradingSessionPolicy,robinhoodEquitySession,coinbaseCryptoSession} from '../../../src/main/trading/session-policy';
const time=(iso:string)=>Date.parse(iso);
describe('shared trading calendars',()=>{
 test('equities wait through the weekend; both crypto venues remain open',()=>{
  const saturday=time('2026-10-17T16:00:00Z');
  expect(robinhoodEquitySession.isOpen(saturday)).toBe(false);
  expect(robinhoodEquitySession.nextOpen(saturday)).toBe(time('2026-10-19T13:30:00Z'));
  for(const venue of ['robinhood','coinbase']){
   const policy=tradingSessionPolicy(venue,'crypto');
   expect(policy.isOpen(saturday)).toBe(true);
   expect(policy.nextOpen(saturday)).toBe(saturday);
  }
 });
 test('equities preserve exact open and close boundaries',()=>{
  expect(robinhoodEquitySession.isOpen(time('2026-10-14T13:29:59Z'))).toBe(false);
  const open=time('2026-10-14T13:30:00Z');
  expect(robinhoodEquitySession.isOpen(open)).toBe(true);
  expect(robinhoodEquitySession.nextOpen(open)).toBe(open);
  expect(robinhoodEquitySession.isOpen(time('2026-10-14T20:00:00Z'))).toBe(false);
 });
 test('holidays, early closes and daylight saving remain equity-specific',()=>{
  const holiday=time('2026-11-26T16:00:00Z');
  expect(robinhoodEquitySession.isOpen(holiday)).toBe(false);
  expect(robinhoodEquitySession.nextOpen(holiday)).toBe(time('2026-11-27T14:30:00Z'));
  expect(robinhoodEquitySession.isOpen(time('2026-11-27T17:59:59Z'))).toBe(true);
  expect(robinhoodEquitySession.isOpen(time('2026-11-27T18:00:00Z'))).toBe(false);
  expect(coinbaseCryptoSession.isOpen(holiday)).toBe(true);
 });
 test('classification aliases share the same equity policy',()=>{
  for(const kind of ['equity','stock','etf'])expect(tradingSessionPolicy('robinhood',kind)).toBe(robinhoodEquitySession);
  expect(tradingSessionPolicy('robinhood','crypto')).toBe(coinbaseCryptoSession);
 });
 test('unknown combinations and invalid clocks cannot authorize execution',()=>{
  for(const [venue,kind] of [['coinbase','equity'],['unknown','crypto'],['robinhood','option']])expect(()=>tradingSessionPolicy(venue,kind)).toThrow('Unsupported');
  for(const policy of [robinhoodEquitySession,coinbaseCryptoSession])for(const now of [NaN,Infinity,1e20]){
   expect(()=>policy.isOpen(now)).toThrow('Invalid');
   expect(()=>policy.nextOpen(now)).toThrow('Invalid');
  }
  expect(()=>robinhoodEquitySession.isOpen(time('2029-01-02T16:00:00Z'))).toThrow('calendar expired');
 });
});

import {basketSessionPolicy,basketCalendar,lastCompletedBasketDay} from '../../../src/main/trading/session-policy';
import type {BasketSpec} from '../../../src/shared/strategies';
const equity={venue:'robinhood',symbol:'BTC'};
const crypto={venue:'robinhood',symbol:'BTC-USD',market:{venue:'robinhood',instance:'production',kind:'crypto' as const,reference:'pair-btc'}};
const basket=(instruments:BasketSpec['target']['weights'][number]['instrument'][]):Pick<BasketSpec,'target'>=>({target:{cashBps:0,weights:instruments.map(instrument=>({instrument,bps:10000/instruments.length}))}});
test('basket calendars distinguish explicit crypto identity and preserve mixed funding dependencies',()=>{
 const saturday=time('2026-10-17T16:00:00Z');
 expect(basketSessionPolicy(basket([crypto])).isOpen(saturday)).toBe(true);
 for(const spec of [basket([equity]),basket([crypto,equity]),basket([]),null])expect(basketSessionPolicy(spec).isOpen(saturday)).toBe(false);
 expect(basketCalendar(basket([crypto]),'2026-10-16','2026-10-19')).toEqual(['2026-10-16','2026-10-17','2026-10-18','2026-10-19']);
 expect(basketCalendar(basket([crypto,equity]),'2026-10-16','2026-10-19')).toEqual(['2026-10-16','2026-10-19']);
 expect(lastCompletedBasketDay(basket([crypto]),'2026-10-19')).toBe('2026-10-18');
 expect(lastCompletedBasketDay(basket([equity,crypto]),'2026-10-19')).toBe('2026-10-16');
});
test('crypto monthly schedules include a weekend first of month',()=>{
 const days=basketCalendar(basket([crypto]),'2026-10-30','2026-11-02');
 expect([...scheduledRebalanceDays(days,'monthly')]).toEqual(['2026-11-01']);
 const mixed=basketCalendar(basket([crypto,equity]),'2026-10-30','2026-11-02');
 expect([...scheduledRebalanceDays(mixed,'monthly')]).toEqual(['2026-11-02']);
});
import {scheduledRebalanceDays} from '../../../src/main/strategies/model-valuation';
