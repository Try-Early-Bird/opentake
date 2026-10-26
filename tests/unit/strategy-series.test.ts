import {test,expect} from 'vitest';
import {historyFromPerformance,seriesFromAllocationHistory} from '../../src/renderer/src/portfolio/strategy-series';
import type {StrategyPerformance} from '../../src/shared/strategy-performance';

const performance=(points:[string,string][],extra:Partial<StrategyPerformance>={})=>({basis:'actual',actualAvailable:true,points:points.map(([day,unitValue])=>({day,unitValue,source:'live'})),...extra}) as unknown as StrategyPerformance;

test('Coinbase Take history scales the actual unit index to the row value and keeps its percent change',()=>{
 const history=historyFromPerformance('a','1m',performance([['2026-10-01','100'],['2026-10-10','110'],['2026-10-20','125']]),'50');
 expect(history?.points).toEqual([{day:'2026-10-01',totalValue:'40.00'},{day:'2026-10-10',totalValue:'44.00'},{day:'2026-10-20',totalValue:'50.00'}]);
 const series=seriesFromAllocationHistory(history!,'1m','TAKE',Date.parse('2026-10-21T00:00:00Z'));
 expect(series?.change).toEqual({amount:'10.00',percent:'25.00'});
});

test('Coinbase Take history falls back to the intraday composition without a usable actual line',()=>{
 const points:[string,string][]=[['2026-10-01','100']];
 expect(historyFromPerformance('a','1m',null,'50')).toBeNull();
 expect(historyFromPerformance('a','1m',performance(points),null)).toBeNull();
 expect(historyFromPerformance('a','1m',performance(points,{actualAvailable:false}),'50')).toBeNull();
 expect(historyFromPerformance('a','1m',performance(points,{basis:'model'}),'50')).toBeNull();
 expect(historyFromPerformance('a','1m',performance(points,{unavailableReason:'no data'}),'50')).toBeNull();
 expect(historyFromPerformance('a','1m',performance([]),'50')).toBeNull();
});
