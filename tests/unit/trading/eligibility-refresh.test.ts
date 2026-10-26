import {expect,test,vi} from 'vitest';
import {createEligibilityRefresh} from '../../../src/main/trading/eligibility-refresh';
import {createRobinhoodEligibility} from '../../../src/main/trading/robinhood-eligibility';

const scope={venue:'coinbase' as const,environment:'production',accountId:'a',authority:'revision-1'};
function pending<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};}

test('pending evidence is shared, isolated per consumer, and never reused after completion',async()=>{
 const refresh=createEligibilityRefresh(()=>123),p=pending<{allowed:boolean}>();
 const load=vi.fn(()=>p.promise);
 const a=refresh.refresh(scope,'product:BTC-USD',load),b=refresh.refresh(scope,'product:BTC-USD',load);
 p.resolve({allowed:true});const [first,second]=await Promise.all([a,b]);
 expect(load).toHaveBeenCalledTimes(1);expect(first.observedAt).toBe(123);
 first.value.allowed=false;expect(second.value.allowed).toBe(true);
 await refresh.refresh(scope,'product:BTC-USD',load);expect(load).toHaveBeenCalledTimes(2);
});

test('account, authority, venue, environment and resource each isolate refreshes',async()=>{
 const refresh=createEligibilityRefresh(),p=pending<boolean>(),load=vi.fn(()=>p.promise);
 const jobs=[scope,{...scope,accountId:'b'},{...scope,authority:'revision-2'},
  {...scope,venue:'robinhood' as const},{...scope,environment:'test'}].map(s=>refresh.refresh(s,'x',load));
 jobs.push(refresh.refresh(scope,'y',load));p.resolve(true);await Promise.all(jobs);
 expect(load).toHaveBeenCalledTimes(6);
});

test('one subscriber cancellation does not cancel another subscriber',async()=>{
 const refresh=createEligibilityRefresh(),p=pending<boolean>(),controller=new AbortController();
 const a=refresh.refresh(scope,'x',()=>p.promise,controller.signal),b=refresh.refresh(scope,'x',()=>p.promise);
 controller.abort();await expect(a).rejects.toThrow();p.resolve(true);expect((await b).value).toBe(true);
});

test('invalidation fences late responses even from a loader that ignores cancellation',async()=>{
 const refresh=createEligibilityRefresh(),p=pending<boolean>();
 const old=refresh.refresh(scope,'x',()=>p.promise);
 const rejected=expect(old).rejects.toThrow();
 await Promise.resolve();refresh.invalidate();
 await rejected; // Must settle before a provider that ignores abort returns.
 expect((await refresh.refresh(scope,'x',async()=>false)).value).toBe(false);
 p.resolve(true);
});

test('refresh failure never falls back to a previous success',async()=>{
 const refresh=createEligibilityRefresh();await refresh.refresh(scope,'x',async()=>true);
 await expect(refresh.refresh(scope,'x',async()=>{throw Error('Unavailable');})).rejects.toThrow('Unavailable');
});

function robinhood(){
 let selected=true;
 const status=async()=>({status:'connected' as const,checkedAt:null,accounts:[{id:'a',selected,agenticAllowed:true,accountType:'cash',maskedNumber:'fixture',nickname:null}]});
 const readTool=vi.fn(async(_name:string,input:Record<string,unknown>)=>(input.symbols as string[]).filter(s=>s!=='MISSING').map(symbol=>({symbol,tradeable:true,fractional:true})));
 return {status,readTool,deselect:()=>{selected=false;}};
}

test('Robinhood batches facts, preserves input order and retains missing facts as unknown',async()=>{
 const f=robinhood(),read=createRobinhoodEligibility(f);
 const symbols=['MISSING',...Array.from({length:11},(_,i)=>`S${i}`)];
 const facts=await read('a',symbols,new AbortController().signal);
 expect(f.readTool).toHaveBeenCalledTimes(2);expect(facts.map(f=>f.symbol)).toEqual(symbols);
 expect(facts[0].tradable).toBeNull();expect(facts[1].tradable).toBe(true);
});

test('Robinhood rejects the wrong account and selection changes during reads',async()=>{
 const f=robinhood(),read=createRobinhoodEligibility(f);
 await expect(read('other',['VTI'],new AbortController().signal)).rejects.toThrow('account unavailable');
 expect(f.readTool).not.toHaveBeenCalled();
 f.readTool.mockImplementationOnce(async()=>{f.deselect();return [{symbol:'VTI',tradeable:true,fractional:true}];});
 await expect(read('a',['VTI'],new AbortController().signal)).rejects.toThrow('account unavailable');
});

test('crypto eligibility uses exact pairs and keeps same-ticker equities separate',async()=>{
 const f=robinhood();
 const instrument={venue:'robinhood' as const,symbol:'BTC-USD',market:{venue:'robinhood' as const,instance:'production',reference:'pair-btc',kind:'crypto' as const}};
 const checks=['Account active','Pair available for trading','Selected account type permits this side','No applicable trading halt'].map(check=>({check,satisfied:true as boolean|null}));
 const calls:string[]=[];
 const read=createRobinhoodEligibility({...f,readTool:async(name,args)=>{
  calls.push(name);
  if(name==='get_equity_tradability')return [{symbol:'BTC-USD',tradeable:false,fractional:false}];
  expect(args).toEqual({currency_pair_id:'pair-btc',side:'buy'});
  return {pairId:'pair-btc',symbol:'BTC-USD',side:'buy',checks};
 }});
 const instruments=[instrument,{venue:'robinhood' as const,symbol:'BTC-USD'}];
 const facts=await read('a',['BTC-USD'],new AbortController().signal,instruments);
 expect(facts).toHaveLength(2);expect(facts[0]).toMatchObject({symbol:'BTC-USD',tradable:false});
 expect(facts[1]).toMatchObject({tradable:true,fractional:true});expect(facts[1].symbol).not.toBe('BTC-USD');
 checks[3].satisfied=null;
 expect((await read('a',['BTC-USD'],new AbortController().signal,[instrument]))[0].tradable).toBeNull();
 checks[3].satisfied=false;
 expect((await read('a',['BTC-USD'],new AbortController().signal,[instrument]))[0].tradable).toBe(false);
 expect(calls).toEqual(['get_equity_tradability','get_crypto_eligibility','get_crypto_eligibility','get_crypto_eligibility']);
});

test('crypto eligibility refuses wrong pair responses and incomplete affirmative checks',async()=>{
 const f=robinhood(),instrument={venue:'robinhood' as const,symbol:'BTC-USD',market:{venue:'robinhood' as const,instance:'production',reference:'pair-btc',kind:'crypto' as const}};
 let response:unknown={pairId:'other',symbol:'BTC-USD',side:'buy',checks:[]};
 const read=createRobinhoodEligibility({...f,readTool:async()=>response});
 await expect(read('a',['BTC-USD'],new AbortController().signal,[instrument])).rejects.toThrow();
 response={pairId:'pair-btc',symbol:'BTC-USD',side:'buy',checks:Array.from({length:4},()=>({check:'Account active',satisfied:true}))};
 await expect(read('a',['BTC-USD'],new AbortController().signal,[instrument])).rejects.toThrow('Incomplete crypto eligibility');
});
