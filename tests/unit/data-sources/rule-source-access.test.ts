import {afterEach,test,expect,vi} from 'vitest';
import {createRuleSourceAccess} from '../../../src/main/data-sources/rule-source-access';
import {coinbaseSourceId,defaultCoinbaseSourceConfig} from '../../../src/shared/coinbase-source';
import {evaluateTakeInput} from '../../../src/main/data-sources/take-inputs';
import type {DataSnapshot} from '../../../src/shared/data-sources';
const ref={sourceId:coinbaseSourceId,feedId:'price:BTC-USD',configVersion:1,schemaVersion:1};
const binding={key:'btc',sourceId:coinbaseSourceId,sourceRevision:1,feedId:ref.feedId,field:'value',kind:'metric' as const,unit:'USD',maxAgeMs:15000};
afterEach(()=>vi.useRealTimers());
function fixture(){
 vi.useFakeTimers();vi.setSystemTime(100000);
 let current={id:coinbaseSourceId,ownerId:'owner',revision:1,enabled:true,validated:true,config:structuredClone(defaultCoinbaseSourceConfig)},available=true;
 let snapshot:DataSnapshot|null=null;
 const custom={peek:vi.fn((refs:any[])=>refs.map(()=>null)),ruleDemand:vi.fn(),ruleFetch:vi.fn()};
 const watchers=new Set<()=>void>();
 const stream={ruleDemand:vi.fn(),inputSnapshot:vi.fn(()=>snapshot),watch:vi.fn((listener:()=>void)=>{watchers.add(listener);return ()=>{watchers.delete(listener);};})};
 const access=createRuleSourceAccess(custom,stream,{get:()=>current},()=>available);
 function sample(at=Date.now()):DataSnapshot{return {connection:'live',quality:'fresh',issue:null,lastReceivedAt:at,latest:{...ref,adapterId:'coinbase-public-stream',adapterVersion:'1',epoch:1,unit:'USD',eventTime:at,receivedAt:at,timeBasis:'provider',clockSkewMs:0,origin:'live',payload:{kind:'metric',value:'101'}}};}
 return {access,custom,stream,sample,watchers,emit:()=>{for(const watcher of [...watchers])watcher();},set:(value:DataSnapshot|null)=>{snapshot=value;},current,available:(value:boolean)=>{available=value;}};
}
test('Take demands deduplicate Coinbase markets and read without acquiring or passing them to generic adapters',()=>{
 const f=fixture(),generic={...ref,sourceId:'00000000-0000-4000-8000-000000000002',feedId:'score'};
 expect(f.access.peek([ref])).toEqual([null]);expect(f.stream.ruleDemand).not.toHaveBeenCalled();
 f.access.demand('one',[ref,generic]);f.access.demand('two',[ref]);expect(f.stream.ruleDemand).toHaveBeenLastCalledWith(['BTC-USD']);
 expect(f.custom.ruleDemand).toHaveBeenNthCalledWith(1,'one',[generic]);
 f.access.demand('one',[]);expect(f.stream.ruleDemand).toHaveBeenLastCalledWith(['BTC-USD']);
 f.set(f.sample());expect(f.access.peek([generic,ref,generic])).toEqual([null,f.sample(),null]);
 f.current.revision=2;expect(f.access.peek([ref])).toEqual([null]);
 f.access.demand('two',[]);expect(f.stream.ruleDemand).toHaveBeenLastCalledWith([]);
});
test('conditional Coinbase fetch waits for a new observation and releases only its temporary demand',async()=>{
 const f=fixture();f.set(f.sample());f.access.demand('one',[ref]);
 const pending=f.access.fetch(binding,'next',500,new AbortController().signal);
 await vi.advanceTimersByTimeAsync(100);f.set(f.sample());f.emit();
 expect(await pending).toMatchObject({quality:'fresh',value:'101'});expect(f.stream.ruleDemand).toHaveBeenLastCalledWith(['BTC-USD']);
 f.access.demand('one',[]);
 const abort=new AbortController();f.set(null);const stopped=f.access.fetch(binding,'next',500,abort.signal);const rejected=expect(stopped).rejects.toThrow('Source unavailable');abort.abort();await rejected;
 expect(f.stream.ruleDemand).toHaveBeenLastCalledWith([]);expect(vi.getTimerCount()).toBe(0);
 const timeout=f.access.fetch(binding,'latest',100,new AbortController().signal),timed=expect(timeout).rejects.toThrow('Source unavailable');await vi.advanceTimersByTimeAsync(100);await timed;
 expect(f.stream.ruleDemand).toHaveBeenLastCalledWith([]);expect(f.custom.ruleFetch).not.toHaveBeenCalled();
});
test('Coinbase input contracts reject wrong markets, units, revisions, backfill and disabled collection',()=>{
 const f=fixture(),source=()=>({...f.current,current_revision:f.current.revision});
 expect(evaluateTakeInput(binding,source(),f.sample(),Date.now()).quality).toBe('fresh');
 for(const change of [{feedId:'messages'},{feedId:'price:BTC-USDC'},{unit:'BTC'},{field:'price'},{kind:'boolean' as const}])expect(evaluateTakeInput({...binding,...change},source(),f.sample(),Date.now()).quality).toBe('invalid');
 expect(evaluateTakeInput(binding,source(),{...f.sample(),latest:{...f.sample().latest!,origin:'backfill'}},Date.now()).quality).toBe('stale');
 f.current.config.collection='when-open';expect(evaluateTakeInput(binding,source(),f.sample(),Date.now()).quality).toBe('disabled');
 expect(f.access.peek([ref])).toEqual([null]);f.current.config.collection='automatic';f.available(false);expect(f.access.peek([ref])).toEqual([null]);
});

test('Coinbase fetch waits on stream events, not a polling loop, and unsubscribes when done',async()=>{
 const f=fixture();f.access.demand('one',[ref]);
 const pending=f.access.fetch(binding,'next',5000,new AbortController().signal);
 const calls=f.stream.inputSnapshot.mock.calls.length;expect(f.watchers.size).toBe(1);
 await vi.advanceTimersByTimeAsync(2000);expect(f.stream.inputSnapshot).toHaveBeenCalledTimes(calls);
 f.set(f.sample());f.emit();
 expect(await pending).toMatchObject({quality:'fresh'});expect(f.watchers.size).toBe(0);expect(vi.getTimerCount()).toBe(0);
});
