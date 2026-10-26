import {createTakeHistory} from '../../src/main/take-history';
import {CoinbaseError} from '../../src/main/coinbase/errors';
import {createCoinbasePreflight} from '../../src/main/coinbase/preflight';
import {afterEach,expect,test} from 'vitest';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {migrate,prepareRestoredDatabase} from '../../src/main/migrations';
import {createCoinbaseCapital} from '../../src/main/coinbase/capital';
import {createTakeAccountPlans} from '../../src/main/strategies/account-plans';
import {createStrategies} from '../../src/main/strategies/service';
import {createTakes} from '../../src/main/takes';
const databases:PGlite[]=[];
afterEach(async()=>{for(const db of databases.splice(0))await db.close();});
async function fixture(twoAssets=false){
 const db=new PGlite();databases.push(db);await migrate(db);let clock=Date.now();
 const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)},capital=createCoinbaseCapital(database,()=>clock);
 const takes=createTakes(database,async()=>{},async()=>({ok:true,source:'runtime',models:[]}));
 const strategies=createStrategies(database,{active:()=>false,ensure:async()=>{},verify:async()=>({policy:'personal_basket',version:1,checkedAt:new Date().toISOString(),accountRef:null,results:[]})});
 const plans=createTakeAccountPlans(database);
 const connection=(await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','synthetic' FROM local_owners RETURNING id")).rows[0].id;
 const account=(await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,available) VALUES($1,'a','Synthetic portfolio',true) RETURNING id",[connection])).rows[0].id;
 await db.query("INSERT INTO coinbase_connection_details(connection_id,label,portfolio_name,can_trade) VALUES($1,'Synthetic portfolio','Synthetic portfolio',true)",[connection]);
 const takeId=await takes.create();
 const proposed=await strategies.propose({targetTakeId:takeId,expectedRevision:null,expectedVersion:null,operationId:randomUUID(),metadata:{title:'Synthetic Take',description:'',rationale:'',holdings:[]},spec:{schemaVersion:1,kind:'basket',target:{weights:twoAssets?[{instrument:{venue:'coinbase',symbol:'BTC'},bps:5000},{instrument:{venue:'coinbase',symbol:'ZEC'},bps:5000}]:[{instrument:{venue:'coinbase',symbol:'BTC'},bps:10000}],cashBps:0},rebalance:{schedule:'never',driftBandPoints:null,driftBandRelative:null}},unsupportedRequests:[]});
 if(!proposed.ok)throw Error(proposed.message);
 const committed=await strategies.commit({targetTakeId:takeId,expectedRevision:proposed.view.draft.id,expectedVersion:null,operationId:randomUUID()});if(!committed.ok)throw Error(committed.message);
 const plan=await plans.read(takeId);await plans.save({takeId,draftRevision:plan.draftRevision,revision:plan.revision,routes:[{venue:'coinbase',accountId:account}]});
 const history={state:'complete',wallets:[{wallet:'usdc',asset:'USDC',balance:'1000',available:'1000',held:'0'}]};
 await db.query("INSERT INTO coinbase_transaction_history(account_id,checked_at,state,data) VALUES($1,$2,'complete',$3)",[account,new Date(clock).toISOString(),JSON.stringify(history)]);
 const input={takeId,kind:'assign' as const,asset:'USDC' as const,quantity:'100'};
 return {db,database,capital,takeId,account,input,plans,takes,strategies,advance:(ms:number)=>{clock+=ms;},clock:()=>clock};
}
test('preview does not fund; confirmation is atomic and retry-safe across service restart',async()=>{
 const f=await fixture(),review=await f.capital.preview(f.input);
 expect(review).toMatchObject({accountLabel:'Synthetic portfolio',quantity:'100',kind:'assign'});
 expect((await f.db.query('SELECT * FROM coinbase_allocations')).rows).toHaveLength(0);
 expect((await f.plans.read(f.takeId)).accounts[0].balances).toEqual([{asset:'USDC',amount:'1000'}]);
 const results=await Promise.all([f.capital.confirm(review.id),f.capital.confirm(review.id)]);
 expect(results[0].balances).toEqual([{asset:'USDC',quantity:'100',reserved:'0'}]);
 expect(results[0].buyingPower).toEqual([{asset:'USDC',amount:'900'}]);
 expect((await f.plans.read(f.takeId)).accounts[0].balances).toEqual([{asset:'USDC',amount:'900'}]);
 f.advance(61000);expect((await createCoinbaseCapital(f.database,f.clock).confirm(review.id)).balances).toEqual(results[0].balances);
 expect((await f.db.query('SELECT * FROM coinbase_allocation_entries')).rows).toHaveLength(1);
 expect((await f.plans.read(f.takeId)).editable).toBe(false);
 expect((await f.plans.forAccount(f.account))[0].capital).toEqual([{asset:'USDC',quantity:'100'}]);
});
test('changed balances roll back review confirmation and capital together',async()=>{
 const f=await fixture(),review=await f.capital.preview(f.input);
 await f.db.query("UPDATE coinbase_transaction_history SET data=jsonb_set(data,'{wallets,0,available}','\"50\"')");
 await expect(f.capital.confirm(review.id)).rejects.toThrow('Insufficient');
 expect((await f.db.query('SELECT state FROM coinbase_capital_reviews')).rows).toEqual([{state:'pending'}]);
 expect((await f.db.query('SELECT * FROM coinbase_allocations')).rows).toHaveLength(0);
});
test('expired, restored, and repointed reviews cannot assign funds',async()=>{
 const f=await fixture(),review=await f.capital.preview(f.input);f.advance(60001);
 await expect(f.capital.confirm(review.id)).rejects.toThrow('expired');
 f.advance(-60001);await f.db.query('DELETE FROM strategy_account_routes');
 await expect(f.capital.confirm(review.id)).rejects.toThrow('explicit Coinbase route');
 await prepareRestoredDatabase(f.db);await expect(f.capital.confirm(review.id)).rejects.toThrow('expired');
});
test('review cannot be changed and currencies cannot be silently substituted',async()=>{
 const f=await fixture();await expect(f.capital.preview({...f.input,asset:'USD'})).rejects.toThrow('unassigned USD');
 const review=await f.capital.preview(f.input);
 await expect(f.db.query("UPDATE coinbase_capital_reviews SET input=jsonb_set(input,'{quantity}','\"999\"') WHERE id=$1",[review.id])).rejects.toThrow('cannot change');
 await f.capital.confirm(review.id);
 const release=await f.capital.preview({...f.input,kind:'release',quantity:'40'});
 expect((await f.capital.confirm(release.id)).balances).toEqual([{asset:'USDC',quantity:'60',reserved:'0'}]);
 await f.capital.confirm(release.id);
 await expect(f.capital.preview({...f.input,kind:'release',quantity:'61'})).rejects.toThrow('unreserved');
 expect((await f.db.query('SELECT * FROM account_orders')).rows).toHaveLength(0);
});
test('archiving after preview prevents assigning funds but permits releasing existing capital',async()=>{
 const f=await fixture(),first=await f.capital.preview(f.input);await f.capital.confirm(first.id);
 const second=await f.capital.preview(f.input);await f.takes.update(f.takeId,{archived:true});
 await expect(f.capital.confirm(second.id)).rejects.toThrow('latest Take changes');
 const release=await f.capital.preview({...f.input,kind:'release'});expect((await f.capital.confirm(release.id)).balances[0].quantity).toBe('0');
});

test('a draft edit invalidates an outstanding assignment review',async()=>{
 const f=await fixture(),review=await f.capital.preview(f.input),view=(await f.strategies.read(f.takeId))!;
 await f.strategies.propose({targetTakeId:f.takeId,expectedRevision:view.draft.id,expectedVersion:view.currentVersion,operationId:randomUUID(),metadata:{...view.draft.metadata,title:'Edited Take'},spec:view.draft.spec,unsupportedRequests:[]});
 await expect(f.capital.confirm(review.id)).rejects.toThrow('latest Take changes');
 await expect(f.capital.preview(f.input)).rejects.toThrow('latest Take changes');
 expect((await f.db.query('SELECT * FROM coinbase_allocation_entries')).rows).toHaveLength(0);
});

test('activity contains confirmed capital only, scoped to account and without replay duplicates',async()=>{
 const f=await fixture(),review=await f.capital.preview(f.input);
 expect(await f.capital.activity(f.account)).toEqual([]);
 await f.capital.confirm(review.id);await f.capital.confirm(review.id);f.advance(1000);
 const release=await f.capital.preview({...f.input,kind:'release',quantity:'25'});await f.capital.confirm(release.id);
 const activity=await f.capital.activity(f.account);
 expect(activity.map(e=>({kind:e.kind,quantity:e.quantity,asset:e.asset}))).toEqual([{kind:'release',quantity:'25',asset:'USDC'},{kind:'assign',quantity:'100',asset:'USDC'}]);
 expect(activity[0]).toMatchObject({takeId:f.takeId,takeTitle:'Synthetic Take'});
 expect(await f.capital.activity(randomUUID())).toEqual([]);
 await f.takes.update(f.takeId,{archived:true});expect(await f.capital.activity(f.account)).toHaveLength(2);
});

test('risk settings persist exact decimals, clear limits and reject stale or cross-account edits',async()=>{
 const f=await fixture();await f.capital.confirm((await f.capital.preview(f.input)).id);
 const view=await f.capital.view(f.takeId),risk=view.risk!;
 const input={takeId:f.takeId,accountId:f.account,allocationId:risk.allocationId,expected:risk.policy,policy:{currency:'USDC' as const,maxDailyNotional:'123.000000000000000001',maxLoss:'0'}};
 const saved=await f.capital.saveRisk(input);
 expect(saved.risk?.policy).toEqual({currency:'USDC',maxDailyNotional:'123.000000000000000001',maxLoss:'0'});
 const {assertCoinbaseRisk}=await import('../../src/main/coinbase/risk');
 await expect(assertCoinbaseRisk(f.db,{allocationId:risk.allocationId,quote:'USDC',orders:[{product:'BTC-USDC',side:'buy',baseSize:'1',limitPrice:'124',notional:'124'}],value:'100',now:f.clock()})).rejects.toThrow('daily notional');
 await expect(assertCoinbaseRisk(f.db,{allocationId:risk.allocationId,quote:'USDC',orders:[],value:'99',now:f.clock()})).rejects.toThrow('loss limit');
 await expect(f.capital.saveRisk(input)).rejects.toThrow('Limits changed');
 await expect(f.capital.saveRisk({...input,accountId:randomUUID()})).rejects.toThrow('allocation changed');
 await expect(f.capital.saveRisk({...input,policy:{...input.policy,maxLoss:'-1'}})).rejects.toThrow('nonnegative');
 const cleared=await createCoinbaseCapital(f.database,f.clock).saveRisk({...input,expected:saved.risk!.policy,policy:{currency:'USD',maxDailyNotional:null,maxLoss:null}});
 expect(cleared.risk?.policy).toEqual({currency:null,maxDailyNotional:null,maxLoss:null});
 await f.db.query('UPDATE coinbase_allocations SET restore_required=true');
 await expect(f.capital.saveRisk(input)).rejects.toThrow('allocation changed');
 expect((await f.db.query('SELECT * FROM account_orders')).rows).toHaveLength(0);
});

 test('cached buying power remains visible after a minute while investment still requires fresh balances',async()=>{
 const f=await fixture();
 f.advance(120000);
 expect((await f.capital.view(f.takeId)).buyingPower).toEqual([{asset:'USDC',amount:'1000'}]);
 await expect(f.capital.preview(f.input)).rejects.toThrow('Fresh complete wallet balances required');
 });

test('Coinbase preflight sizes unfunded buys without assigning capital and caches only product reads',async()=>{
 const f=await fixture(),calls:string[]=[];
 const preflight=createCoinbasePreflight(f.database,{
  scope:async()=>({accountRef:f.account,label:'Synthetic',authority:'synthetic-authority'} as never),
  product:async(_scope,id)=>{calls.push(id);return {product_id:id,base_currency_id:'BTC',quote_currency_id:id.split('-')[1],product_type:'SPOT',price:'100',base_increment:'0.001',quote_increment:'0.01',price_increment:'0.01',base_min_size:'0.001',base_max_size:'1000',quote_min_size:'1',quote_max_size:'100000',is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,view_only:false,status:'online'};},
 },f.clock);
 const small=await preflight({takeId:f.takeId,quote:'USDC',quantity:'0.50'});
 expect(small).toMatchObject({ok:false,minimumAmount:'1',legs:[]});
 const sized=await preflight({takeId:f.takeId,quote:'USDC',quantity:'10'});
 expect(sized).toMatchObject({ok:true,minimumAmount:'1',legs:[{symbol:'BTC',notional:'10',weightPercent:100}]});
 expect(calls).toEqual(['BTC-USDC']);
 await preflight({takeId:f.takeId,quote:'USD',quantity:'20'});
 expect(calls).toEqual(['BTC-USDC','BTC-USD']);
 expect((await f.db.query('SELECT * FROM coinbase_allocations')).rows).toHaveLength(0);
 expect((await f.db.query('SELECT * FROM coinbase_order_reviews')).rows).toHaveLength(0);
 await f.db.query('UPDATE coinbase_connection_details SET can_trade=false');
 await expect(preflight({takeId:f.takeId,quote:'USD',quantity:'20'})).rejects.toThrow('trading account');
});

test('multi-asset preflight serializes connector reads across currencies and retries temporary sync contention',async()=>{
 const f=await fixture(true);let active=0,peak=0,first=true;const calls:string[]=[];
 const preflight=createCoinbasePreflight(f.database,{
  scope:async()=>({accountRef:f.account,label:'Synthetic',authority:'synthetic'} as never),
  product:async(_scope,id)=>{
   if(first){first=false;throw new CoinbaseError('busy');}
   active++;peak=Math.max(peak,active);calls.push(id);
   try{await new Promise(resolve=>setTimeout(resolve,5));return {product_id:id,base_currency_id:id.split('-')[0],quote_currency_id:id.split('-')[1],product_type:'SPOT',price:'100',base_increment:'0.001',quote_increment:'0.01',price_increment:'0.01',base_min_size:'0.001',base_max_size:'1000',quote_min_size:'1',quote_max_size:'100000',is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,view_only:false,status:'online'};}finally{active--;}
  },
 },f.clock);
 const results=await Promise.all((['USDC','USD'] as const).map(quote=>preflight({takeId:f.takeId,quote,quantity:'10'})));
 expect(peak).toBe(1);expect(calls).toHaveLength(4);
 for(const result of results){expect(result.ok).toBe(true);expect(result.legs.map(leg=>[leg.symbol,leg.notional])).toEqual([['BTC','5'],['ZEC','5']]);}
 expect((await f.db.query('SELECT * FROM coinbase_allocations')).rows).toHaveLength(0);
});

test('Take summary values only allocated quantities and withholds stale or missing prices',async()=>{
 const f=await fixture(),review=await f.capital.preview(f.input);await f.capital.confirm(review.id);
 expect((await f.capital.view(f.takeId)).valuation?.value).toBeNull();
 const data={portfolio:{currency:'USD'},spotPositions:[{asset:'USDC',quantity:'1000',marketValue:'999',currency:'USD'},{asset:'BTC',quantity:'2',marketValue:'200000',currency:'USD'}],warnings:[]};
 await f.db.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)',[f.account,new Date(f.clock()).toISOString(),JSON.stringify(data)]);
 expect((await f.capital.view(f.takeId)).valuation).toEqual({currency:'USD',value:'99.9'});
 expect((await f.capital.view(f.takeId)).balances[0]).toMatchObject({price:'0.999',value:'99.9'});
 f.advance(900001);expect((await f.capital.view(f.takeId)).valuation?.value).toBeNull();
 expect((await f.capital.view(f.takeId)).balances[0].price).toBeUndefined();
 f.advance(-900001);
 await f.db.query("UPDATE coinbase_portfolio_observations SET data=jsonb_set(data,'{spotPositions}','[]')");
 expect((await f.capital.view(f.takeId)).valuation?.value).toBeNull();
});

test('Take history recognizes Coinbase funding and clears invested after release',async()=>{
 const f=await fixture(),history=createTakeHistory(f.database);
 const status=async()=>(await history.takes(false)).items.find(t=>t.id===f.takeId)?.strategy;
 expect(await status()).toMatchObject({status:'committed',invested:false});
 await f.capital.confirm((await f.capital.preview(f.input)).id);
 expect(await status()).toMatchObject({status:'committed',invested:true});
 await f.capital.confirm((await f.capital.preview({...f.input,kind:'release'})).id);
 expect(await status()).toMatchObject({status:'committed',invested:false});
});
