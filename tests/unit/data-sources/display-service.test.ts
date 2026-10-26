import {expect,test,vi} from 'vitest';
import {createSourceDisplays} from '../../../src/main/data-sources/display-service';
import type {PortfolioAPI} from '../../../src/shared/portfolio';
import type {DataSourcesAPI} from '../../../src/shared/data-sources';
function fixture(){
 const market=vi.fn(async(symbol:string)=>({symbol,displayName:symbol,fundamentals:null}));
 const series=vi.fn(async()=>({venue:'robinhood_agentic',range:'1d',asOf:'2026-10-17T12:00:00Z',series:[],staleSymbols:[],pendingSymbols:[],refreshingSymbols:[]}));
 const detail=vi.fn(async()=>({source:'authenticated',market:{id:'BTC-USD',price:'100'},observedAt:'2026-10-17T12:00:00Z',stale:false}));
 const coinbaseSeries=vi.fn(async()=>({series:null,stale:false,observedAt:'2026-10-17T12:00:00Z'}));
 const storedMarketPrice=vi.fn(async()=>{throw Error('Must not read public cache');});
 const service=createSourceDisplays({market,series,coinbaseMarkets:{detail,series:coinbaseSeries},storedMarketPrice} as unknown as Pick<PortfolioAPI,'market'|'series'|'coinbaseMarkets'>&Pick<DataSourcesAPI,'storedMarketPrice'>);
 return {service,market,series,detail,coinbaseSeries,storedMarketPrice};
}
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
test('display consumers share only identical in-flight work and receive isolated results',async()=>{
 const f=fixture();
 const [one,two]=await Promise.all([f.service.market('AAPL'),f.service.market('AAPL')]);
 expect(f.market).toHaveBeenCalledTimes(1);one.displayName='changed';expect(two.displayName).toBe('AAPL');
 await f.service.market('AAPL');expect(f.market).toHaveBeenCalledTimes(2);
 await Promise.all([f.service.series(a,'1d',['AAPL']),f.service.series(a,'1d',['AAPL']),f.service.series(b,'1d',['AAPL']),f.service.series(a,'1w',['AAPL'])]);
 expect(f.series).toHaveBeenCalledTimes(3);
 await Promise.all([f.service.coinbaseDetail('BTC-USD',a),f.service.coinbaseDetail('BTC-USD',a),f.service.coinbaseDetail('BTC-USD',b)]);
 expect(f.detail).toHaveBeenCalledTimes(2);expect(f.storedMarketPrice).not.toHaveBeenCalled();
 await f.service.coinbaseSeries('BTC-USD','1m');expect(f.coinbaseSeries).toHaveBeenCalledExactlyOnceWith('BTC-USD','1m');
});
test('display adapter preserves provider errors, rejects stale generations and validates identity before calls',async()=>{
 const f=fixture();
 expect(()=>f.service.series('not-an-account','1d')).toThrow();expect(()=>f.service.coinbaseDetail('../bad')).toThrow();expect(f.series).not.toHaveBeenCalled();
 f.market.mockRejectedValueOnce(Error('fixture unavailable'));
 await expect(f.service.market('AAPL')).rejects.toThrow('fixture unavailable');
 expect((await f.service.market('AAPL')).symbol).toBe('AAPL');
 let resolve!:(value:{symbol:string;displayName:string;fundamentals:null})=>void;
 f.market.mockImplementationOnce(()=>new Promise(done=>{resolve=done;}));
 const pending=f.service.market('MSFT');await Promise.resolve();f.service.invalidate();resolve({symbol:'MSFT',displayName:'old',fundamentals:null});
 await expect(pending).rejects.toThrow('changed');
 f.service.close();await expect(f.service.market('AAPL')).rejects.toThrow('stopping');
});
