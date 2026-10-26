import { expect, test, vi } from 'vitest';
import { coinbaseSearchAdapter } from '../../src/main/search/coinbase';
import type { CoinbaseMarketsAPI } from '../../src/shared/coinbase-markets';
const row = (id = 'BTC-USD', name = 'Bitcoin', type = 'SPOT') => ({ product_id: id, base_currency_id: id.split('-')[0], quote_currency_id: id.split('-')[1], base_name: name, product_type: type });
function setup(pages: unknown[], stale = false) {
 const get = vi.fn(async () => pages.shift());
 const detail = vi.fn<CoinbaseMarketsAPI['detail']>();
 const adapter = coinbaseSearchAdapter({ cachedPublic: async <T>(_key: string, _kind: 'catalog'|'product', _ttl: number, load: (get: (path: string) => Promise<unknown>) => Promise<T>) => ({ data: await load(get), observedAt: new Date().toISOString(), stale }) }, { detail }, async () => true);
 return { adapter, get, detail };
}
test('Coinbase searches paginated spot products by name and pair with distinct identities', async () => {
 const { adapter, get } = setup([{products:[row(),row('BTC-PERP','Bitcoin','FUTURE')],pagination:{has_next:true,next_cursor:'next'}},{products:[row('BTC-EUR'),row('BCH-USD','Bitcoin Cash')],pagination:{has_next:false}}]);
 expect(await adapter.status()).toMatchObject({connected:true,capabilities:{screening:false,details:true}});
 const result = await adapter.lookup('bitcoin',new AbortController().signal);
 expect(result.markets.map(m=>m.identity.reference)).toEqual(['BTC-USD','BTC-EUR','BCH-USD']);
 expect(get.mock.calls[1][0]).toContain('cursor=next');
 expect(result.markets.every(m=>adapter.owns(m))).toBe(true);
 expect(adapter.owns({...result.markets[0],identity:{...result.markets[0].identity,venue:'robinhood'}})).toBe(false);
});
test('Coinbase preserves pair query, rejects inconsistent identities and marks stale catalog partial', async () => {
 const {adapter}=setup([{products:[row(),row('BTC-EUR'),{...row('ETH-USD'),base_currency_id:'BTC'}]}],true);
 const result=await adapter.lookup('btc-usd',new AbortController().signal);
 expect(result.markets.map(m=>m.symbol)).toEqual(['BTC-USD']);expect(result.incomplete).toBe(true);
});
test('Coinbase refuses repeated pagination and cancellation',async()=>{
 const {adapter}=setup([{products:[],pagination:{has_next:true,next_cursor:'same'}},{products:[],pagination:{has_next:true,next_cursor:'same'}}]);
 await expect(adapter.lookup('btc',new AbortController().signal)).rejects.toThrow('pagination');
 const stopped=setup([]);const controller=new AbortController();controller.abort();
 await expect(stopped.adapter.lookup('btc',controller.signal)).rejects.toThrow();expect(stopped.get).not.toHaveBeenCalled();
});
test('Coinbase resolves exact product identity and refuses stale or mismatched detail',async()=>{
 const {adapter,detail}=setup([{products:[row()]}]);const signal=new AbortController().signal;
 const locator=(await adapter.lookup('btc',signal)).markets[0];
 const market={id:'BTC-USD',venue:'coinbase' as const,base:'BTC',quote:'USD',name:'Bitcoin',price:null,change24h:null,volume24h:null,status:'online',tradingDisabled:false};
 detail.mockResolvedValue({market,observedAt:new Date().toISOString(),stale:false});
 expect(await adapter.resolve(locator,signal)).toEqual(locator);
 detail.mockResolvedValue({market:{...market,id:'BTC-EUR'},observedAt:'',stale:false});expect(await adapter.resolve(locator,signal)).toBeNull();
 detail.mockResolvedValue({market,observedAt:'',stale:true});expect(await adapter.resolve(locator,signal)).toBeNull();
});
