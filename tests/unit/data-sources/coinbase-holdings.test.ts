import { expect, test, vi } from 'vitest';
import { createCoinbaseHoldingsStream } from '../../../src/main/data-sources/coinbase-stream/holdings';
import { valueCoinbaseHoldings } from '../../../src/main/coinbase/live-valuation';
test('deduplicates accounts, renews demand, releases removed holdings and retries expired leases',async()=>{
 let products=['BTC-USD','BTC-USD','ETH-USD','USDC-USD'], available=true;
 const active=new Map<string,string>();let sequence=0;
 const dispatch=vi.fn((request:any)=>{
  if(request.action==='acquire'){const id=String(++sequence);active.set(id,request.product);return {leaseId:id};}
  if(request.action==='renew')return request.ids.filter(id=>active.has(id)).map(leaseId=>({leaseId}));
  if(request.action==='release')for(const id of request.ids)active.delete(id);
  return null;
 });
 const dropClient=vi.fn(()=>active.clear());
 const service=createCoinbaseHoldingsStream({dispatch,dropClient,price:()=> '100'} as never,async()=>products,()=>available);
 await service.tick();expect([...active.values()]).toEqual(['BTC-USD','ETH-USD']);
 await service.tick();expect(sequence).toBe(2);
 products=['ETH-USD'];await service.tick();expect([...active.values()]).toEqual(['ETH-USD']);
 active.clear();await service.tick();expect(sequence).toBe(3);
 available=false;await service.tick();expect(active.size).toBe(0);expect(service.price('ETH-USD')).toBeNull();
 available=true;await service.tick();expect(service.price('ETH-USD')).toBe('100');
 service.close();expect(active.size).toBe(0);
});
test('capacity rejection preserves other leases and closes late discovery without acquiring',async()=>{
 let resolve!:(value:string[])=>void;
 const dispatch=vi.fn(()=>{throw Error('capacity');});
 const service=createCoinbaseHoldingsStream({dispatch,dropClient:vi.fn(),price:()=>null} as never,()=>new Promise(r=>resolve=r),()=>true);
 const tick=service.tick();service.close();resolve(['BTC-USD']);await tick;
 expect(dispatch).not.toHaveBeenCalled();
});
test('revaluation uses decimal quantities and preserves cash, basis and saved observations',()=>{
 const saved={portfolio:{totalValue:'250',currency:'USD',cash:'50',buyingPower:'50'},spotPositions:[
  {instrumentRef:'coinbase:BTC',asset:'BTC',quantity:'0.1',marketValue:'200',unrealizedPnl:'20',averageEntryPrice:'1800',currency:'USD',availableValue:'100',isCash:false},
  {instrumentRef:'coinbase:USD',asset:'USD',quantity:'50',marketValue:'50',currency:'USD',availableValue:'50',isCash:true},
 ]};
 const result=valueCoinbaseHoldings(saved,1000,2000,()=> '3000');
 expect(result.portfolio).toEqual({...saved.portfolio,totalValue:'350'});
 expect(result.spotPositions[0]).toMatchObject({marketValue:'300',unrealizedPnl:'120',averageEntryPrice:'1800',quantity:'0.1',availableValue:'100'});
 expect(result.spotPositions[1]).toEqual(saved.spotPositions[1]);expect(saved.portfolio.totalValue).toBe('250');
 expect(valueCoinbaseHoldings(saved,1000,902000,()=> '3000')).toBe(saved);
 expect(valueCoinbaseHoldings(saved,1000,2000,()=>null)).toEqual(saved);
});

test('capacity overflow uses fallback and is retried without releasing accepted products',async()=>{
 const active=new Map<string,string>();let products=['BTC-USD','ETH-USD'];
 const stream={
  dispatch(request:any){
   if(request.action==='renew')return request.ids.filter(id=>active.has(id)).map(leaseId=>({leaseId}));
   if(request.action==='release'){for(const id of request.ids)active.delete(id);return null;}
   if(active.size===1)throw Error('capacity');
   active.set(request.product,request.product);return {leaseId:request.product};
  },
  dropClient(){active.clear();},price(){return '100';},
 };
 const service=createCoinbaseHoldingsStream(stream as never,async()=>products,()=>true);
 await service.tick();expect(service.price('BTC-USD')).toBe('100');expect(service.price('ETH-USD')).toBeNull();
 products=['ETH-USD'];await service.tick();expect(service.price('BTC-USD')).toBeNull();expect(service.price('ETH-USD')).toBe('100');
 service.close();
});

test('renews more than 32 held markets in bounded IPC batches',async()=>{
 const products=Array.from({length:40},(_,i)=>'ASSET'+i+'-USD'), sizes:number[]=[];
 const stream={dispatch(request:any){if(request.action==='renew'){sizes.push(request.ids.length);return request.ids.map(leaseId=>({leaseId}));}return {leaseId:request.product};},dropClient(){},price(){return null;}};
 const service=createCoinbaseHoldingsStream(stream as never,async()=>products,()=>true);
 await service.tick();await service.tick();expect(sizes).toEqual([32,8]);service.close();
});

test('source policies reconcile holdings and manual markets without account reads when disabled',async()=>{
 let policy={collection:'automatic' as 'automatic'|'when-open'|'off',subscriptions:{holdings:true,views:true,products:['SOL-USD','BTC-USD']}};
 const active=new Map<string,{product:string;usage:string}>(),load=vi.fn(async()=>['BTC-USD']);
 const stream={dispatch(request:any){
  if(request.action==='renew')return request.ids.filter(id=>active.has(id)).map(leaseId=>({leaseId}));
  if(request.action==='release'){request.ids.forEach(id=>active.delete(id));return null;}
  active.set(request.product,{product:request.product,usage:request.usage});return {leaseId:request.product};
 },dropClient(){active.clear();},price(){return '10';}};
 const manager=createCoinbaseHoldingsStream(stream as never,load,()=>true,()=>policy);
 await manager.tick();expect([...active.values()]).toEqual([{product:'BTC-USD',usage:'holdings'},{product:'SOL-USD',usage:'manual'}]);
 policy={...policy,subscriptions:{...policy.subscriptions,holdings:false}};
 await manager.tick();expect(active.get('BTC-USD')?.usage).toBe('manual');expect(load).toHaveBeenCalledTimes(1);
 policy={...policy,collection:'when-open'};await manager.tick();expect(active.size).toBe(0);expect(load).toHaveBeenCalledTimes(1);
 policy={...policy,collection:'automatic',subscriptions:{...policy.subscriptions,products:['ETH-USD']}};
 await manager.tick();expect([...active.keys()]).toEqual(['ETH-USD']);manager.close();
});
