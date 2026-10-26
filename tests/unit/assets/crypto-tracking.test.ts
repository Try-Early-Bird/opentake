import {expect,test} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {migrate} from '../../../src/main/migrations';
import {createCryptoPriceHistory} from '../../../src/main/assets/crypto-price-history';
import {trackedRobinhoodAssets} from '../../../src/main/assets/tracker';
import {marketKey} from '../../../src/shared/search';
import {createAccountSync} from '../../../src/main/account-sync/service';
import {accountSyncInterval} from '../../../src/main/account-sync/cadence';
const now=Date.parse('2026-10-18T15:00:30Z');
async function fixture(){
 const db=new PGlite();await migrate(db);
 const database={use:async<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const connection=(await db.query<{id:string}>(`INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners RETURNING id`)).rows[0].id;
 const account=(await db.query<{id:string}>(`INSERT INTO linked_accounts(connection_id,external_ref,masked_number,agentic_allowed,selected) VALUES($1,'synthetic','test',true,true) RETURNING id`,[connection])).rows[0].id;
 return {db,database,account};
}
test('price cache scopes routes/accounts, deduplicates a minute and preserves gaps/previous close',async()=>{
 const f=await fixture();try{
  const cache=createCryptoPriceHistory(f.database,()=>now);
  const q={pairId:'btc',symbol:'BTC-USD',routing:'route-a',observedAt:'2026-10-18T15:00:00Z',mark:'90000',previousClose:'89000'};
  await cache.record(f.account,[q,{...q,observedAt:'2026-10-18T15:00:20Z',mark:'90010'},{...q,routing:'route-b',mark:'89900'},
   {...q,observedAt:'2026-10-17T15:00:00Z'},{...q,observedAt:'2026-10-18T15:01:00Z'}]);
  await cache.record(f.account,[q]);
  const ref=marketKey({identity:{venue:'robinhood',instance:'production',reference:'btc',kind:'crypto'}});
  const history=await cache.read(f.account,ref,'route-a','2026-10-01T00:00:00Z','2026-10-19T00:00:00Z');
  expect(history.coverage).toBe('observed_only');expect(history.samples).toHaveLength(1);
  expect(Number(history.samples[0].price)).toBe(90010);expect(history.samples[0].closeDay).toBe('2026-10-17');expect(Number(history.samples[0].previousClose)).toBe(89000);
  expect((await cache.read(f.account,ref,'unknown','2026-10-01T00:00:00Z','2026-10-19T00:00:00Z')).samples).toEqual([]);
 }finally{await f.db.close();}
});
test('normal sync persists outside crypto orders for tracking and retains prior evidence after read failure',async()=>{
 const f=await fixture();let sync:ReturnType<typeof createAccountSync>|undefined;
 try{
  const ref=marketKey({identity:{venue:'robinhood',instance:'production',reference:'btc',kind:'crypto'}});
  let fail=false,terminal=false,t=now;
  const seen:string[][]=[];
  sync=createAccountSync(f.database as any,{status:async()=>({status:'connected',checkedAt:null,accounts:[{id:f.account,selected:true,agenticAllowed:true}]}),readTool:async(name:string)=>name==='get_portfolio'?{total_value:'100',cash:'100',buying_power:'100'}:{results:[]}} as any,()=>t,async()=>[],async(_account,_since,open)=>{
   seen.push(open);if(fail)throw Error('offline');
   return [{providerOrderRef:'outside',clientRef:null,instrumentRef:ref,symbol:'BTC-USD',origin:'unknown',side:'buy',orderType:'limit',timeInForce:'gtc',state:terminal?'canceled':'confirmed',quantity:'0.01',notionalAmount:null,cumulativeQuantity:'0',averagePrice:null,limitPrice:'90000',stopPrice:null,sourceCreatedAt:new Date(now).toISOString(),sourceUpdatedAt:new Date(t).toISOString(),executions:[],providerPayload:{}}];
  });
  await sync.synchronize();expect(await trackedRobinhoodAssets(f.db,f.account)).toMatchObject([{symbol:'BTC-USD',reasons:['open_order']}]);
  expect((await f.db.query('SELECT * FROM strategy_attribution_entries')).rows).toEqual([]);
  fail=true;t+=60000;await expect(sync.synchronize()).rejects.toThrow();
  expect((await trackedRobinhoodAssets(f.db,f.account))[0].reasons).toEqual(['open_order']);
  fail=false;terminal=true;t+=60000;await sync.synchronize();
  expect(seen).toEqual([[],['outside'],['outside']]);expect(await trackedRobinhoodAssets(f.db,f.account)).toEqual([]);
 }finally{sync?.cancel();await f.db.close();}
});
test('tracked crypto uses continuous polling while equities retain their normal cadence',()=>{
 expect(accountSyncInterval(now,false,false,true)).toBe(60000);
 expect(accountSyncInterval(now,true,false,true)).toBe(30000);
 expect(accountSyncInterval(now,false,true,true)).toBe(5000);
 expect(accountSyncInterval(now,false)).toBe(21600000);
});
