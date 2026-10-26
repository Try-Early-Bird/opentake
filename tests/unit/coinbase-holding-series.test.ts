import {expect,test,vi} from 'vitest';
import {createCoinbaseHoldingSeries} from '../../src/main/coinbase/holding-series';
import type {PortfolioView} from '../../src/shared/portfolio';
const id='11111111-1111-4111-8111-111111111111',now=Date.parse('2026-10-11T12:25:00Z');
const view:PortfolioView={account:{id,venue:'coinbase',label:'Test',selected:false,available:true},accounts:[],portfolio:null,resources:[],history:[],positionHistory:[],positions:[],orders:[],executions:[],gaps:[],spotPositions:[{instrumentRef:'coinbase:BTC',asset:'BTC',quantity:'2',marketValue:'200',availableValue:null,currency:'USD',isCash:false},{instrumentRef:'coinbase:USD',asset:'USD',quantity:'50',marketValue:'50',availableValue:null,currency:'USD',isCash:true}]};
const candle=(start:number,close:string)=>({start:String(start/1000),open:close,high:close,low:close,close,volume:'1'});
test('holding sparklines use exact quote pairs and ordered 24-hour crypto candles, without changing account values',async()=>{
 const candles=vi.fn(async(_pair:string,start:string,end:string)=>({candles:[candle(Date.parse(end)-3600000,'110'),candle(Date.parse(start),'100')],stale:false}));
 const load=createCoinbaseHoldingSeries(async()=>view,{candles},()=>now);
 const result=await load({accountId:id,range:'1d'});
 expect(candles).toHaveBeenCalledWith('BTC-USD','2026-10-10T12:00:00.000Z','2026-10-11T12:00:00.000Z',3600);
 expect(result.series[0]).toMatchObject({symbol:'BTC',price:'110',change:{amount:'10',percent:'10'},dayStart:'2026-10-10T12:00:00.000Z'});
 expect(result.series[0].points[0].c).toBe('100');expect(result.staleSymbols).toEqual(['BTC']); // Missing buckets are reported.
 expect(view.spotPositions?.[0].marketValue).toBe('200');expect(candles).toHaveBeenCalledTimes(1);
});
test('unavailable pairs never fabricate a flat or dollar-equivalent series',async()=>{
 const candles=vi.fn(async()=>({candles:[],stale:false}));
 const result=await createCoinbaseHoldingSeries(async()=>({...view,spotPositions:[{...view.spotPositions![0],currency:'EUR'}]}),{candles},()=>now)({accountId:id,range:'1m'});
 expect(candles.mock.calls).toHaveLength(1);expect(result.series).toEqual([]);expect(result.staleSymbols).toEqual(['BTC']);
});
test('long ranges split into cache-supported candle windows and reject another account',async()=>{
 const candles=vi.fn(async()=>({candles:[],stale:false}));const load=createCoinbaseHoldingSeries(async()=>view,{candles},()=>now);
 await load({accountId:id,range:'1y'});expect(candles).toHaveBeenCalledTimes(2);
 await expect(load({accountId:'22222222-2222-4222-8222-222222222222',range:'1d'})).rejects.toThrow('unavailable');
});
test('requested sparkline symbols stay limited to visible holdings on the named account',async()=>{
 const candles=vi.fn(async()=>({candles:[],stale:false}));
 const load=createCoinbaseHoldingSeries(async()=>view,{candles},()=>now);
 await load({accountId:id,range:'1d',symbols:['ETH']});expect(candles).not.toHaveBeenCalled();
});
