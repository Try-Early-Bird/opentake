import {expect,test,vi} from 'vitest';
import {loadCoinbaseDisplay} from '../../../src/renderer/src/data-sources/coinbase-display';
import type {CoinbaseMarketSnapshot} from '../../../src/shared/coinbase-markets';
import type {StoredMarketPrice} from '../../../src/shared/data-sources';
const now=Date.parse('2026-10-17T12:00:00Z');
const detail:CoinbaseMarketSnapshot={source:'public',observedAt:new Date(now).toISOString(),stale:false,market:{id:'BTC-USD',venue:'coinbase',base:'BTC',quote:'USD',name:'Bitcoin',price:'123',change24h:'2.5',volume24h:'1000',status:'online',tradingDisabled:false}};
const snapshot:StoredMarketPrice={market:{venue:'coinbase',instance:'production',kind:'crypto',reference:'BTC-USD'},quality:'fresh',quote:{payload:{kind:'quote',price:'123.123456789123456789'},currency:'USD',receivedAt:now,eventTime:null,timeBasis:'receipt',origin:'stored',provider:'coinbase',sourceId:null,revision:null,feedId:null,maxAgeMs:60000}};
test('public display adopts the shared quote without changing statistics or repeating the provider request',async()=>{
 const fetch=vi.fn(async()=>structuredClone(detail)),read=vi.fn(async()=>structuredClone(snapshot));
 const result=await loadCoinbaseDisplay('BTC-USD',undefined,fetch,read);
 expect(result.market.price).toBe(snapshot.quote!.payload.price);expect(result.market.change24h).toBe('2.5');expect(result.market.volume24h).toBe('1000');
 expect(fetch).toHaveBeenCalledExactlyOnceWith('BTC-USD',undefined);expect(read).toHaveBeenCalledExactlyOnceWith(snapshot.market);
 expect((await loadCoinbaseDisplay('BTC-USD',undefined,fetch,async()=>({...snapshot,quality:'stale'}))).stale).toBe(true);
});
test('authenticated displays never consume public cached prices',async()=>{
 const read=vi.fn(async()=>snapshot);
 expect(await loadCoinbaseDisplay('BTC-USD','fixture-account',async()=>detail,read)).toBe(detail);
 const authenticated={...detail,source:'authenticated' as const};
 expect(await loadCoinbaseDisplay('BTC-USD',undefined,async()=>authenticated,read)).toBe(authenticated);
 expect(read).not.toHaveBeenCalled();
});
test('mismatched observations and unavailable shared reads preserve existing display',async()=>{
 const candidates:StoredMarketPrice[]=[{...snapshot,quality:'missing',quote:null},{...snapshot,quality:'invalid'}, {...snapshot,market:{...snapshot.market,reference:'ETH-USD'}},{...snapshot,market:{...snapshot.market,instance:'sandbox'}},{...snapshot,quote:{...snapshot.quote!,currency:'EUR'}},{...snapshot,quote:{...snapshot.quote!,receivedAt:now+1}}];
 for(const candidate of candidates)expect(await loadCoinbaseDisplay('BTC-USD',undefined,async()=>detail,async()=>candidate)).toBe(detail);
 expect(await loadCoinbaseDisplay('BTC-USD',undefined,async()=>detail,async()=>{throw Error('Fixture IPC failure');})).toBe(detail);
 await expect(loadCoinbaseDisplay('BTC-USD',undefined,async()=>{throw Error('Fixture provider failure');},async()=>snapshot)).rejects.toThrow('Fixture provider failure');
});
