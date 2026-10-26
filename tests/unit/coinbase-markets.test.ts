import {migrate} from '../../src/main/migrations';
import {afterEach,expect,test,vi} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {createCoinbasePriceCache} from '../../src/main/coinbase/price-cache';
import {createCoinbaseMarkets} from '../../src/main/coinbase/markets';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();});
const product=(id='BTC-USD')=>({product_id:id,product_type:'SPOT',base_currency_id:id.split('-')[0],quote_currency_id:id.split('-')[1],base_name:'Bitcoin',price:'500',price_percentage_change_24h:'2.5%',volume_24h:'10',status:'online'});
const json=(data:unknown)=>new Response(JSON.stringify(data));
async function fixture(fetcher:typeof fetch,now=()=>Date.parse('2026-10-11T13:30:00Z')){const db=new PGlite();cleanup.push(()=>db.close());await migrate(db);const database={use:<T>(work:(db:PGlite)=>Promise<T>)=>work(db)};return {prices:createCoinbasePriceCache(database,fetcher,now),database};}
test('detail rejects mismatched identities and unsafe inputs; unavailable prices stay null',async()=>{
 const fetcher=vi.fn().mockImplementationOnce(()=>json({...product(),price:'',price_percentage_change_24h:'NaN'})).mockImplementationOnce(()=>json(product('BTC-USD')));
 const {prices}=await fixture(fetcher),service=createCoinbaseMarkets(prices);const result=await service.detail('BTC-USD');expect(result.market.price).toBe(null);expect(result.market.change24h).toBe(null);
 await expect(service.detail('BTC-USDC')).rejects.toThrow('unavailable');await expect(service.detail('../secrets')).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(2);
});
test('unheld pairs use shared candles, include the unfinished bucket and retain crypto time boundaries',async()=>{
 const now=Date.parse('2026-10-11T13:30:00Z');const fetcher=vi.fn(async(input:unknown)=>{const u=new URL(String(input)),start=Number(u.searchParams.get('start')),end=Number(u.searchParams.get('end'));return json({candles:Array.from({length:(end-start)/3600},(_,i)=>({start:String(start+i*3600),open:'10',high:'11',low:'9',close:String(10+i),volume:'1'}))});});
 const {prices}=await fixture(fetcher,()=>now);const service=createCoinbaseMarkets(prices,()=>now);const result=await service.series('ETH-USDC','1d');
 expect(String(fetcher.mock.calls[0][0])).toContain('/ETH-USDC/candles');expect(result.series?.symbol).toBe('ETH-USDC');expect(result.series?.points.at(-1)?.t).toBe(new Date(now).toISOString());expect(result.stale).toBe(false);
 await service.series('ETH-USDC','1d');expect(fetcher).toHaveBeenCalledTimes(1);
});

test('maps provider high, low and quote volume without converting or inventing missing values',async()=>{
 const fetcher=vi.fn().mockImplementationOnce(()=>json({...product(),approximate_quote_24h_volume:'114212726.43',high_24h:'83176.22',low_24h:'82711.66'})).mockImplementationOnce(()=>json({...product('BTC-USDC'),approximate_quote_24h_volume:'',high_24h:'NaN'}));
 const {prices}=await fixture(fetcher),service=createCoinbaseMarkets(prices);
 const usd=(await service.detail('BTC-USD')).market;
 expect(usd).toMatchObject({quote:'USD',volume24h:'10',quoteVolume24h:'114212726.43',high24h:'83176.22',low24h:'82711.66'});
 const usdc=(await service.detail('BTC-USDC')).market;
 expect(usdc).toMatchObject({quote:'USDC',quoteVolume24h:null,high24h:null,low24h:null});
});

test('authenticated product metadata uses the selected connection without silently returning public data',async()=>{
 const fetcher=vi.fn(),read=vi.fn().mockResolvedValue({...product(),market_cap:'1500000000000',about_description:'Bitcoin description'});
 const {prices}=await fixture(fetcher),service=createCoinbaseMarkets(prices,Date.now,read),account='00000000-0000-4000-8000-000000000001';
 expect(await service.detail('BTC-USD',account)).toMatchObject({source:'authenticated',market:{marketCap:'1500000000000',description:'Bitcoin description'}});
 expect(read).toHaveBeenCalledWith(account,'BTC-USD');
 read.mockRejectedValueOnce(Error('Authentication failed'));
 await expect(service.detail('BTC-USD',account)).rejects.toThrow('Authentication failed');
 read.mockResolvedValueOnce({...product(),market_cap:'',about_description:''});
 expect((await service.detail('BTC-USD',account)).market).toMatchObject({marketCap:null,description:null});
 await expect(service.detail('BTC-USD','invalid')).rejects.toThrow();
 expect(fetcher).not.toHaveBeenCalled();
});
