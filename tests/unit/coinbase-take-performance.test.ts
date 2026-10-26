import {expect,test} from 'vitest';
import {valueTakeMovements,createCoinbaseTakePerformance,type TakeMovement} from '../../src/main/coinbase/take-performance';
const at=(hour:number)=>`2026-10-12T${String(hour).padStart(2,'0')}:00:00.000Z`;
const e=(hour:number,asset:string,quantity:string,kind='fill'):TakeMovement=>({at:at(hour),asset,quantity,kind});
test('actual returns include fill fees and exclude later deposits and withdrawals',()=>{
 const entries=[e(1,'USDC','100','capital'),e(2,'USDC','-51'),e(2,'BTC','0.5'),e(3,'USDC','100','capital'),e(4,'USDC','-50','release')];
 const marks=valueTakeMovements(entries,[at(5)],asset=>asset==='BTC'?100:1);
 expect(marks[1]).toMatchObject({value:99,unitValue:99,netCapital:100});
 expect(marks.at(-1)?.value).toBe(149);
 expect(marks.at(-1)?.unitValue).toBeCloseTo(99);
 expect(marks.at(-1)?.netCapital).toBe(150);
});
test('holdings are replayed at each timestamp, not applied retroactively',()=>{
 const entries=[e(1,'USD','100','capital'),e(3,'USD','-100'),e(3,'BTC','1')];
 const marks=valueTakeMovements(entries,[at(2),at(4)],(asset,time)=>asset==='USD'?1:time>=at(4)?110:100);
 expect(marks.find(p=>p.at===at(2))?.value).toBe(100);
 expect(marks.at(-1)).toMatchObject({value:110,unitValue:110,netCapital:100});
});
test('USDC uses its observed exchange rate, including when valuing contributions',()=>{
 const marks=valueTakeMovements([e(1,'USDC','100','capital')],[at(2)],(_asset,time)=>time===at(1)?.99:1);
 expect(marks.at(-1)?.netCapital).toBe(99);
 expect(marks.at(-1)?.unitValue).toBeCloseTo(100/99*100);
});
test('missing prices or negative claims do not fabricate returns',()=>{
 expect(valueTakeMovements([e(1,'USDC','100','capital')],[at(2)],()=>null)).toEqual([]);
 expect(valueTakeMovements([e(1,'USD','10','capital'),e(2,'USD','-11')],[at(3)],()=>1)).toEqual([]);
});
test('multiple funding currencies and a partial sell retain proceeds and fees',()=>{
 const marks=valueTakeMovements([e(1,'USD','50','capital'),e(1,'USDC','50','capital'),e(2,'USD','-40'),e(2,'BTC','.4'),e(3,'BTC','-.2'),e(3,'USDC','21.5')],[at(4)],(asset,time)=>asset==='BTC'?(time>=at(3)?110:100):1);
 expect(marks.at(-1)?.value).toBeCloseTo(103.5);
 expect(marks.at(-1)?.netCapital).toBe(100);
});
test('service builds a same-day chart and P&L from cached candles and fresh marks',async()=>{
 const entries=[e(1,'USDC','10','capital'),e(2,'USDC','-5.1'),e(2,'BTC','.05')].map(e=>({...e,allocationId:'a'}));
 const database={use:async(fn:(db:unknown)=>unknown)=>fn({query:async(sql:string)=>({rows:sql.includes('e.quantity::text')?entries:sql.includes('restore_required')?[]:[{observed_at:new Date(at(3)),data:{portfolio:{currency:'USD'},spotPositions:[{asset:'USDC',quantity:'100',marketValue:'100',currency:'USD'},{asset:'BTC',quantity:'1',marketValue:'110',currency:'USD'}]}}]})})};
 const prices={dailySpot:async()=> '1',candles:async(product:string,start:string,end:string)=>({stale:false,candles:Array.from({length:(Date.parse(end)-Date.parse(start))/3600000},(_,i)=>({start:String((Date.parse(start)+i*3600000)/1000),open:'1',high:'1',low:'1',volume:'1',close:product==='BTC-USD'?'100':'1'}))})};
 const service=createCoinbaseTakePerformance(database as never,prices,()=>Date.parse(at(3)));
 expect(await service.summary('s')).toMatchObject({currency:'USD',gain:expect.any(String)});
 expect(Number((await service.summary('s'))?.gain)).toBeCloseTo(.4);
 const result=await service.performance('s','1d',{rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}} as never);
 expect(result.actualAvailable).toBe(true);expect(result.intraday?.points.length).toBeGreaterThan(1);
 expect(Number(result.stats[0].allTimeReturnPercent)).toBeCloseTo(4);
});

test('actual USDC history uses spot rates and remains visible without a fresh account endpoint',async()=>{
 const entries=[e(1,'USDC','100','capital'),e(2,'USDC','-50'),e(2,'BTC','.5')].map(e=>({...e,allocationId:'a'}));
 const database={use:async(fn:(db:unknown)=>unknown)=>fn({query:async(sql:string)=>({rows:sql.includes('e.quantity::text')?entries:[]})})};
 const called:string[]=[];
 const prices={dailySpot:async(product:string)=>{called.push(product);return '.99';},candles:async(product:string,start:string,end:string)=>{
  expect(product).toBe('BTC-USD');
  return {stale:false,candles:Array.from({length:(Date.parse(end)-Date.parse(start))/3600000},(_,i)=>({start:String((Date.parse(start)+i*3600000)/1000),open:'100',high:'100',low:'100',volume:'1',close:'100'}))};
 }};
 const service=createCoinbaseTakePerformance(database as never,prices,()=>Date.parse(at(4)));
 const result=await service.performance('s','1d',{rebalance:{schedule:'never'}} as never);
 expect(result.intraday?.points.length).toBeGreaterThan(1);
 expect(called).toContain('USDC-USD');
 // A chart can show recorded history; current P&L must not claim a stale endpoint is live.
 expect(await service.summary('s')).toBeNull();
 expect(Number(result.stats[0].allTimeReturnPercent)).toBeCloseTo(100*(99.5/99-1));
});

test('simulated Coinbase history uses the shared model and published version weights',async()=>{
 const database={use:async(fn:(db:unknown)=>unknown)=>fn({query:async()=>({rows:[]})})};
 const spec={schemaVersion:1 as const,kind:'basket' as const,target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:5000},{instrument:{venue:'coinbase',symbol:'ZEC'},bps:5000}],cashBps:0},rebalance:{schedule:'never' as const,driftBandPoints:null,driftBandRelative:null}};
 const second={...spec,target:{weights:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:10000}],cashBps:0}};
 const prices={dailySpot:async()=> '1',candles:async(product:string,_start:string,_end:string,interval?:number)=>{
  expect(interval).toBe(86400);
  const values=product==='BTC-USD'?['100','110','120']:['100','90','100'];
  return {stale:false,candles:values.map((close,index)=>({start:String(Date.parse(`2026-10-${String(9+index).padStart(2,'0')}T00:00:00Z`)/1000),open:close,high:close,low:close,volume:'1',close}))};
 }};
 const service=createCoinbaseTakePerformance(database as never,prices,()=>Date.parse(at(3)));
 const result=await service.performance('s','1m',second,'model',[{id:'v1',sequence:1,spec,createdAt:new Date('2026-10-09T00:00:00Z')},{id:'v2',sequence:2,spec:second,createdAt:new Date('2026-10-10T00:00:00Z')}]);
 expect(result.basis).toBe('model');expect(result.actualAvailable).toBe(false);expect(result.intraday).toBeNull();
 expect(result.points).toHaveLength(3);
 expect(Number(result.points[1].unitValue)).toBeCloseTo(100);
 expect(Number(result.points[2].unitValue)).toBeCloseTo(120/110*100);
 const draft=await service.performance('s','1m',spec,'model');
 expect(draft.points.every(p=>p.source==='backtested')).toBe(true);
 expect(Number(draft.points.at(-1)?.unitValue)).toBeCloseTo(110);
});
test('markers preserve USD and USDC deposit and withdrawal amounts without valuing released crypto as dollars',async()=>{
 const entries=[e(1,'USD','5','capital'),e(2,'USDC','10','capital'),e(3,'USDC','-3','release'),e(4,'BTC','-.001','release')];
 const database={use:async(fn:(db:unknown)=>unknown)=>fn({query:async(sql:string)=>({rows:sql.includes('e.quantity::text')?entries:[]})})};
 const service=createCoinbaseTakePerformance(database as never,{} as never,()=>Date.parse(at(5)));
 expect(await service.markers('s','1d')).toMatchObject([
  {amount:'5',currency:'USD',kinds:{invested:1}},
  {amount:'10',currency:'USDC',kinds:{deposit:1}},
  {amount:'3',currency:'USDC',kinds:{withdrew:1}},
  {amount:null,currency:'BTC'},
 ]);
});

test('markers omit zero-movement cancelled attempts but retain actual withdrawal proceeds',async()=>{
 const entries=[e(0,'USDC','0','capital'),e(1,'USDC','10','capital'),e(2,'USDC','0.000000','release'),e(3,'USDC','-2.984268849324','release'),e(4,'BTC','0','release'),e(5,'USDC','-0.001','release')];
 const database={use:async(fn:(db:unknown)=>unknown)=>fn({query:async(sql:string)=>({rows:sql.includes('e.quantity::text')?entries:[]})})};
 const service=createCoinbaseTakePerformance(database as never,{} as never,()=>Date.parse(at(6)));
 expect(await service.markers('s','1d')).toMatchObject([
  {at:at(1),amount:'10',kinds:{invested:1}},
  {at:at(3),amount:'2.984268849324',kinds:{withdrew:1}},
  {at:at(5),amount:'0.001',kinds:{withdrew:1}},
 ]);
});

test('live marks update current Take P&L while historical candles stay unchanged',async()=>{
 const entries=[e(1,'USDC','10','capital'),e(2,'USDC','-5.1'),e(2,'BTC','.05')].map(e=>({...e,allocationId:'a'}));
 const database={use:async(fn:(db:unknown)=>unknown)=>fn({query:async(sql:string)=>({rows:sql.includes('e.quantity::text')?entries:sql.includes('restore_required')?[]:[{observed_at:new Date(at(3)),data:{portfolio:{currency:'USD'},spotPositions:[{asset:'USDC',quantity:'100',marketValue:'100',currency:'USD'},{asset:'BTC',quantity:'1',marketValue:'110',currency:'USD'}]}}]})})};
 const prices={dailySpot:async()=> '1',candles:async(product:string,start:string,end:string)=>({stale:false,candles:Array.from({length:(Date.parse(end)-Date.parse(start))/3600000},(_,i)=>({start:String((Date.parse(start)+i*3600000)/1000),open:'1',high:'1',low:'1',volume:'1',close:product==='BTC-USD'?'100':'1'}))})};
 const service=createCoinbaseTakePerformance(database as never,prices,()=>Date.parse(at(3)),undefined,product=>product==='BTC-USD'?'120':null);
 expect(await service.summary('s')).toMatchObject({currency:'USD',gain:expect.any(String)});
 expect(Number((await service.summary('s'))?.gain)).toBeCloseTo(.9);
 const result=await service.performance('s','1d',{rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}} as never);
 expect(result.actualAvailable).toBe(true);expect(result.intraday?.points.length).toBeGreaterThan(1);
 expect(Number(result.stats[0].allTimeReturnPercent)).toBeCloseTo(9);
});
