import {expect,test,vi} from 'vitest';
import {createPortfolioSeries} from '../../../src/main/market-series/service';
import type {PortfolioView} from '../../../src/shared/portfolio';
const id='11111111-1111-4111-8111-111111111111';
const now=Date.parse('2026-10-02T16:00:00Z');
function fixture(){
 let clock=now,connected=true,busy=false;
 const symbols=['VTI'];
 const readTool=vi.fn(async(name:string,args:Record<string,unknown>)=>name==='get_equity_historicals'?{results:(args.symbols as string[]).map(symbol=>({symbol,bars:[
  {begins_at:'2026-10-01T19:55:00Z',open_price:'98',high_price:'98',low_price:'98',close_price:'98',session:'reg'},
  {begins_at:'2026-10-02T13:30:00Z',open_price:'100',high_price:'100',low_price:'100',close_price:'100',session:'reg'},
  {begins_at:'2026-10-02T14:30:00Z',open_price:'102',high_price:'102',low_price:'102',close_price:'102',session:'reg'},
 ]}))}:{results:(args.symbols as string[]).map(symbol=>({symbol,last_trade_price:'102',previous_close:'98'}))});
 const account={id,venue:'robinhood',label:'Synthetic',selected:true,available:true};
 const snapshot=async()=>({account,accounts:[account],positions:symbols.map(symbol=>({symbol,instrumentRef:`instrument-${symbol}`,quantity:'1',markPrice:'102',marketValue:'102',currency:'USD',assetClass:'equity'})),positionHistory:[],history:[],resources:[],orders:[],executions:[],gaps:[],portfolio:null} as PortfolioView);
 const service=createPortfolioSeries({status:async()=>({status:connected?'connected':'disconnected',checkedAt:null,accounts:[{id,selected:true,agenticAllowed:true,maskedNumber:'fixture',nickname:null,accountType:'cash'}]}),busy:()=>busy,readTool},snapshot,()=>clock);
 return {service,readTool,symbols,account,advance:()=>{clock+=61000;},disconnect:()=>{connected=false;},busy:()=>{busy=true;}};
}
test('new local profile receives real historical bars and previous-close change through read-only tools',async()=>{
 const f=fixture();const input={accountId:id,range:'1d'};
 const p=await f.service(input);
 expect(p.series[0].points).toHaveLength(2);expect(p.series[0].baseline).toEqual({price:'98',kind:'previous_close'});
 expect(p.series[0].change?.percent).toBeDefined();expect(p.staleSymbols).toEqual([]);
 expect(f.readTool.mock.calls.map(c=>c[0])).toEqual(['get_equity_historicals','get_equity_quotes']);
 expect(f.readTool.mock.calls[0][1]).toMatchObject({symbols:['VTI'],interval:'5minute',bounds:'24_5',adjustment_type:'split'});
 expect(await f.service(input)).toEqual(p);expect(f.readTool).toHaveBeenCalledTimes(2);
});
test('ranges and accounts cannot reuse unrelated history; disconnected accounts cannot read cached data',async()=>{
 const f=fixture();await f.service({accountId:id,range:'1d'});await f.service({accountId:id,range:'1y'});
 expect(f.readTool.mock.calls[2][1]).toMatchObject({interval:'day',bounds:'regular'});
 await expect(f.service({accountId:'22222222-2222-4222-8222-222222222222',range:'1d'})).rejects.toThrow();
 f.disconnect();await expect(f.service({accountId:id,range:'1d'})).rejects.toThrow();
});
test('failed refresh preserves real cached series and reports stale; empty history stays empty',async()=>{
 const f=fixture();const input={accountId:id,range:'1d'};const good=await f.service(input);f.advance();
 f.readTool.mockRejectedValue(new Error('fixture failure'));
 const stale=await f.service(input);expect(stale.series).toEqual(good.series);expect(stale.staleSymbols).toEqual(['VTI']);
 const empty=fixture();empty.readTool.mockResolvedValue({results:[]});
 expect(await empty.service(input)).toMatchObject({series:[],staleSymbols:['VTI']});
});
test('busy sync defers without provider calls; a large portfolio fills in bounded batches',async()=>{
 const busy=fixture();busy.busy();expect(await busy.service({accountId:id,range:'1d'})).toMatchObject({series:[],pendingSymbols:['VTI']});expect(busy.readTool).not.toHaveBeenCalled();
 const f=fixture();f.symbols.splice(0,1,...Array.from({length:12},(_,i)=>`X${i}`));
 const first=await f.service({accountId:id,range:'1d'});expect(first.series).toHaveLength(10);expect(first.pendingSymbols).toHaveLength(2);
 const second=await f.service({accountId:id,range:'1d'});expect(second.series).toHaveLength(12);expect(second.pendingSymbols).toEqual([]);
});
test('account switch while awaiting provider data rejects the result',async()=>{
 const f=fixture();const original=f.readTool.getMockImplementation()!;
 f.readTool.mockImplementation(async(name,args)=>{const result=await original(name,args);f.disconnect();return result;});
 await expect(f.service({accountId:id,range:'1d'})).rejects.toThrow();
});
