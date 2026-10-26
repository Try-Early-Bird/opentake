import {CoinbaseError} from '../../src/main/coinbase/errors';
import { afterEach, expect, test, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { createCoinbasePriceCache, publicPriceCacheMigration } from '../../src/main/coinbase/price-cache';
const close:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of close.splice(0))await cleanup();});
const hour=3600000,start=Date.parse('2026-09-01T00:00:00Z');
const iso=(t:number)=>new Date(t).toISOString();
const bar=(t:number)=>({start:String(t/1000),open:'10',high:'11',low:'9',close:'10.5',volume:'20'});
async function fixture(){const db=new PGlite();close.push(()=>db.close());await db.exec(publicPriceCacheMigration.sql);return {db,use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)};}
test('shares covered candles, survives service restart, and fetches only missing windows',async()=>{
 const db=await fixture();const fetcher=vi.fn(async(url:unknown)=>{const u=new URL(String(url));const from=Number(u.searchParams.get('start'))*1000,to=Number(u.searchParams.get('end'))*1000;return new Response(JSON.stringify({candles:Array.from({length:(to-from)/hour},(_,i)=>bar(from+i*hour))}));});
 const cache=createCoinbasePriceCache(db,fetcher,()=>start+10*86400000);
 const result=await Promise.all([cache.candles('BTC-USD',iso(start),iso(start+2*hour)),cache.candles('BTC-USD',iso(start),iso(start+3*hour))]);
 expect(result.map(r=>r.candles.length)).toEqual([2,3]);expect(fetcher).toHaveBeenCalledTimes(2);
 expect(new URL(String(fetcher.mock.calls[1][0])).searchParams.get('start')).toBe(String((start+2*hour)/1000));
 await createCoinbasePriceCache(db,fetcher,()=>start+10*86400000).candles('BTC-USD',iso(start),iso(start+3*hour));expect(fetcher).toHaveBeenCalledTimes(2);
 await cache.candles('BTC-USDC',iso(start),iso(start+hour));expect(fetcher).toHaveBeenCalledTimes(3);
});
test('refreshes recent candles while preserving good cached data during failure and backing off gaps',async()=>{
 const db=await fixture();let now=start+hour;const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({candles:[bar(start)]}))).mockResolvedValue(new Response('',{status:429}));
 const cache=createCoinbasePriceCache(db,fetcher,()=>now);
 await cache.candles('BTC-USD',iso(start),iso(start+hour));now+=6*60000;
 const retained=await cache.candles('BTC-USD',iso(start),iso(start+hour));expect(retained.candles).toHaveLength(1);expect(retained.stale).toBe(true);
 await cache.candles('BTC-USD',iso(start),iso(start+hour));expect(fetcher).toHaveBeenCalledTimes(2);
 await cache.candles('OMG-USD',iso(start),iso(start+hour));await cache.candles('OMG-USD',iso(start),iso(start+hour));expect(fetcher).toHaveBeenCalledTimes(3);
});
test('caches dated spot separately, validates pair and rejects an unfinished date',async()=>{
 const db=await fixture();const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:{base:'USDC',currency:'USD',amount:'0.9998'}}))).mockResolvedValueOnce(new Response(JSON.stringify({data:{base:'BTC',currency:'USD',amount:'20'}})));
 const cache=createCoinbasePriceCache(db,fetcher,()=>start+2*86400000);
 expect(await cache.dailySpot('USDC-USD','2026-09-01')).toBe('0.9998');expect(await cache.dailySpot('USDC-USD','2026-09-01')).toBe('0.9998');expect(fetcher).toHaveBeenCalledTimes(1);
 await expect(cache.dailySpot('OMG-USD','2026-09-01')).rejects.toThrow();
 await expect(cache.dailySpot('USDC-USD','2026-09-03')).rejects.toThrow();
 expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
});

test('MCP candle cache misses are authenticated first, share cached buckets and fall back only on provider failure or no account',async()=>{
 const db=await fixture(),fetcher=vi.fn(async()=>new Response(JSON.stringify({candles:[bar(start)]}))),mcp=vi.fn().mockResolvedValue({candles:[bar(start)]});
 const cache=createCoinbasePriceCache(db,fetcher,()=>start+10*86400000,mcp);
 await cache.candles('BTC-USD',iso(start),iso(start+hour));await cache.candles('BTC-USD',iso(start),iso(start+hour));
 expect(mcp).toHaveBeenCalledExactlyOnceWith('BTC-USD',iso(start),iso(start+hour),3600);expect(fetcher).not.toHaveBeenCalled();
 mcp.mockRejectedValueOnce(new CoinbaseError('provider'));
 expect((await cache.candles('ETH-USD',iso(start),iso(start+hour))).candles).toHaveLength(1);expect(fetcher).toHaveBeenCalledTimes(1);
 mcp.mockRejectedValueOnce(new CoinbaseError('unavailable'));
 expect((await cache.candles('DOGE-USD',iso(start),iso(start+hour))).candles).toHaveLength(1);expect(fetcher).toHaveBeenCalledTimes(2);
 mcp.mockRejectedValueOnce(new CoinbaseError('authentication'));
 await expect(cache.candles('SOL-USD',iso(start),iso(start+hour))).rejects.toMatchObject({code:'authentication'});expect(fetcher).toHaveBeenCalledTimes(2);
});


test('current spot uses the public conversion endpoint and never reuses a dated or stale quote',async()=>{
 const db=await fixture(),fetcher=vi.fn().mockImplementation(async()=>new Response(JSON.stringify({data:{base:'USDC',currency:'USD',amount:'0.9998'}}))),mcp=vi.fn();
 const cache=createCoinbasePriceCache(db,fetcher,()=>start+2*86400000,mcp);
 await cache.dailySpot('USDC-USD','2026-09-01');
 expect(await cache.currentSpot('USDC-USD')).toBe('0.9998');
 expect(fetcher.mock.calls[1][0]).toBe('https://api.coinbase.com/v2/prices/USDC-USD/spot');
 expect(fetcher.mock.calls[1][1].headers).toBeUndefined();expect(mcp).not.toHaveBeenCalled();
 fetcher.mockResolvedValueOnce(new Response('',{status:503}));
 await expect(cache.currentSpot('USDC-USD')).rejects.toThrow('current USDC/USD conversion rate');
});

test.each([
 {base:'BTC',currency:'USD',amount:'1'},
 {base:'USDC',currency:'EUR',amount:'1'},
 {base:'USDC',currency:'USD',amount:'0'},
 {base:'USDC',currency:'USD',amount:'NaN'},
 {},
])('current spot rejects incomplete or mismatched quotes: %j',async data=>{
 const db=await fixture(),cache=createCoinbasePriceCache(db,vi.fn(async()=>new Response(JSON.stringify({data}))));
 await expect(cache.currentSpot('USDC-USD')).rejects.toThrow('Retry preview');
});
