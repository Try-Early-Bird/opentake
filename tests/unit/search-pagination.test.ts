import { expect, test } from 'vitest';
import { marketPage, rankMarkets, marketKey, type MarketHit } from '../../src/shared/search';
const hit = (venue: string, i: number): MarketHit => ({identity:{venue,instance:'production',reference:String(i),kind:'crypto'},symbol:`COIN${i}-USD`,name:`Coin ${i}`,venueLabel:venue,typeLabel:'Crypto'});
test('shared market pages contain 20 total across venues with no gaps or duplicate identities',()=>{
 const rh=Array.from({length:30},(_,i)=>hit('robinhood',i));
 const cb=Array.from({length:25},(_,i)=>hit('coinbase',i));
 const ranked=rankMarkets([...rh,...cb,rh[0]],'coin');
 expect(ranked).toHaveLength(55);
 const pages=[0,1,2].map(page=>marketPage(ranked,page));
 expect(pages.map(p=>p.markets.length)).toEqual([20,20,15]);
 expect(pages.flatMap(p=>p.markets).map(marketKey)).toEqual(ranked.map(marketKey));
 expect(new Set(pages[0].markets.map(m=>m.identity.venue)).size).toBe(2);
 expect(marketPage(ranked,99).page).toBe(2);
 expect(marketPage([],1)).toEqual({markets:[],page:0,pages:1,total:0});
});
test('global relevance outranks source order and remains stable when sources finish in reverse order',()=>{
 const rh=Array.from({length:30},(_,i)=>hit('robinhood',i));
 const exact={...hit('coinbase',99),name:'Bitcoin',symbol:'BTC-USD'};
 const partial={...hit('robinhood',98),name:'Bitcoin Cash',symbol:'BCH-USD'};
 expect(rankMarkets([...rh,partial,exact],'bitcoin')[0]).toEqual(exact);
 expect(rankMarkets([...rh,partial,exact],'bitcoin')).toEqual(rankMarkets([exact,partial,...rh],'bitcoin'));
});
