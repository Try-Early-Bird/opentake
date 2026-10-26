import { expect, test } from 'vitest';
import { freshCoinbaseTrade } from '../../../src/renderer/src/data-sources/useCoinbaseLivePrice';
import type { CoinbaseStreamRead } from '../../../src/shared/coinbase-stream';
const now = Date.parse('2026-10-19T12:00:00Z');
function snapshot(): NonNullable<CoinbaseStreamRead['snapshot']> {
  return {product:'ETH-USD',connection:'live',continuity:'live',issue:null,book:null,trades:[
    {trade_id:'1',product_id:'ETH-USD',price:'2345.67',size:'1',side:'BUY',time:new Date(now-1000).toISOString(),origin:'live'},
  ]};
}
test('uses a fresh trade from the viewed product',()=>{
 expect(freshCoinbaseTrade(snapshot(),'ETH-USD',now)).toBe('2345.67');
 expect(freshCoinbaseTrade(snapshot(),'BTC-USD',now)).toBeNull();
});
test('continuity, age and trade origin must all qualify before replacing fetched price',()=>{
 for(const mode of ['retry','gap','stale','future','backfill','invalid'] as const){
  const s=snapshot();
  if(mode==='retry')s.connection='retrying';
  if(mode==='gap')s.continuity='unavailable';
  if(mode==='stale')s.trades[0].time=new Date(now-15001).toISOString();
  if(mode==='future')s.trades[0].time=new Date(now+2001).toISOString();
  if(mode==='backfill')s.trades[0].origin='backfill';
  if(mode==='invalid')s.trades[0].price='NaN';
  expect(freshCoinbaseTrade(s,'ETH-USD',now),mode).toBeNull();
 }
 expect(freshCoinbaseTrade(null,'ETH-USD',now)).toBeNull();
});
