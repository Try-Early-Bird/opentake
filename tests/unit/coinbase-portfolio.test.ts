import { afterEach, expect, test, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../src/main/migrations';
import { createCoinbasePortfolio, normalizeCoinbasePortfolio, applyCoinbasePositionDetails } from '../../src/main/coinbase/portfolio';
import { createPlatformPortfolios } from '../../src/main/account-sync/platform-portfolios';
import { pruneFinancialObservations } from '../../src/main/allocations/retention';
import { CoinbaseError } from '../../src/main/coinbase/errors';
import type { PortfolioView } from '../../src/shared/portfolio';
const payload = (value = '125') => ({ portfolio_balances: { total_balance: { value, currency: 'USD' } }, spot_positions: [{ asset: 'BTC', total_balance_crypto: 1e-8, total_balance_fiat: value, is_cash: false }] });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(unavailable = () => false, readHistory?: () => Promise<import('../../src/main/coinbase/history').CoinbaseHistory>, readActivity?: Parameters<typeof createCoinbasePortfolio>[1]['readActivity'], livePrice?: (product:string)=>string|null, dustPolicy?:()=>import('../../src/shared/crypto-dust').CryptoDustPolicy,sourceOptions?:Parameters<typeof createCoinbasePortfolio>[6]) {
 const db = new PGlite(); cleanup.push(() => db.close()); await migrate(db);
 const connection = (await db.query<{id:string}>("INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,'coinbase','connected','synthetic' FROM local_owners RETURNING id")).rows[0].id;
 const ids = (await db.query<{id:string}>("INSERT INTO linked_accounts(connection_id,external_ref,masked_number,selected,agentic_allowed) VALUES($1,'fake-a','A',false,false),($1,'fake-b','B',false,false) RETURNING id", [connection])).rows.map(r => r.id);
 let now = Date.parse('2026-10-09T12:00:00Z');
 const list = vi.fn(async () => ids.map((accountId, i) => ({accountId, label: ['Crypto A', 'Crypto B'][i], status: 'connected'})));
 const readChat = vi.fn(async (scope: {accountRef:string}) => ({data: payload(scope.accountRef === ids[0] ? '125' : '900')}));
 const assertChatScope = vi.fn(async () => {});
 const chatScope = vi.fn(async (accountRef: string) => ({accountRef, label: 'Synthetic', authority: 'fake'}));
 const service = createCoinbasePortfolio({use: work => work(db)}, {list, chatScope, assertChatScope, readChat, readHistory, readActivity} as unknown as Parameters<typeof createCoinbasePortfolio>[1], () => now, unavailable, livePrice, dustPolicy,sourceOptions);
 return {db, ids, service, readChat, list, chatScope, assertChatScope, advance: (ms:number) => {now += ms;}, now:()=>now};
}
test('Coinbase normalization preserves dust and zero, rejects incomplete or inconsistent snapshots', () => {
 expect(normalizeCoinbasePortfolio(payload()).spotPositions[0]).toMatchObject({instrumentRef:'coinbase:BTC', quantity:'0.00000001'});
 expect(normalizeCoinbasePortfolio(payload('0')).portfolio).toEqual({totalValue:'0',cash:null,buyingPower:null,currency:'USD'});
 expect(() => normalizeCoinbasePortfolio({spot_positions:[]})).toThrow();
 expect(() => normalizeCoinbasePortfolio({...payload(),spot_positions:undefined})).toThrow();
 expect(() => normalizeCoinbasePortfolio({...payload(),spot_positions:[...payload().spot_positions,...payload().spot_positions]})).toThrow();
 expect(() => normalizeCoinbasePortfolio({...payload(),portfolio_balances:{...payload().portfolio_balances,total_cash_equivalent_balance:{value:'1',currency:'EUR'}}})).toThrow();
});
test('Coinbase caches each account separately, keeps good data on failure and never assigns Take ownership', async () => {
 const f = await fixture();
 expect((await f.service.snapshot(f.ids[0])).portfolio).toBeNull(); expect(f.readChat).not.toHaveBeenCalled();
 await f.service.refresh(f.ids[0]); await f.service.refresh(f.ids[1]);
 const a = await f.service.snapshot(f.ids[0]), b = await f.service.snapshot(f.ids[1]);
 expect(a.portfolio?.totalValue).toBe('125'); expect(b.portfolio?.totalValue).toBe('900');
 expect(a.strategies).toEqual([]); expect(a.positions).toEqual([]); expect(a.history).toHaveLength(1);
 expect((await f.service.accounts()).map(a=>a.balance?.totalValue)).toEqual(['125','900']);
 f.readChat.mockRejectedValueOnce(new CoinbaseError('provider'));
 await expect(f.service.refresh(f.ids[0])).rejects.toMatchObject({code:'provider'});
 expect((await f.service.snapshot(f.ids[0]))).toMatchObject({portfolio:{totalValue:'125'},resources:[{state:'failed'}]});
 expect((await f.service.snapshot(f.ids[1])).resources[0].state).toBe('completed');
});
test('Coinbase refresh deduplicates, refuses revoked authority and records interrupted work', async () => {
 const f = await fixture();
 const first = f.service.refresh(f.ids[0]); expect(f.service.refresh(f.ids[0])).toBe(first); await first;
 expect(f.readChat).toHaveBeenCalledTimes(1);
 f.assertChatScope.mockRejectedValueOnce(new CoinbaseError('unavailable'));
 await expect(f.service.refresh(f.ids[1])).rejects.toThrow();
 expect((await f.service.snapshot(f.ids[1])).portfolio).toBeNull();
 await f.db.query("UPDATE coinbase_portfolio_sync SET state='running'"); await f.service.start();
 expect((await f.service.snapshot(f.ids[0])).resources[0]).toMatchObject({state:'interrupted'});
});
test('financial retention prunes Coinbase history but preserves the last observation for each account', async () => {
 const f = await fixture(); await f.service.refresh(f.ids[0]); await f.service.refresh(f.ids[1]);
 f.advance(86400000); await f.service.refresh(f.ids[0]); f.advance(400*86400000);
 await pruneFinancialObservations(f.db,f.now());
 expect((await f.db.query('SELECT * FROM coinbase_portfolio_observations')).rows).toHaveLength(2);
 expect((await f.service.snapshot(f.ids[1])).portfolio?.totalValue).toBe('900');
});
test('portfolio routing keeps Coinbase separate from trading selection and handles forgotten accounts without fallback', async () => {
 const empty:PortfolioView = {account:null,accounts:[],portfolio:null,resources:[],history:[],positions:[],positionHistory:[],orders:[],executions:[],gaps:[]};
 const rhAccount={id:'rh',venue:'robinhood',label:'RH',selected:true,available:true};
 const cbAccount={id:'cb',venue:'coinbase',label:'CB',selected:false,available:true};
 const rh={snapshot:vi.fn(async()=>({...empty,account:rhAccount,accounts:[rhAccount]}))};
 const cb={accounts:async()=>[cbAccount],snapshot:vi.fn(async()=>({...empty,account:cbAccount})),refresh:vi.fn(async()=>{})};
 const refreshRH=vi.fn(async()=>{});
 const router=createPlatformPortfolios(rh as never,cb as never,refreshRH);
 expect((await router.snapshot('cb')).account?.id).toBe('cb'); expect(rh.snapshot.mock.calls).toEqual([[]]);
 expect((await router.snapshot('forgotten')).account).toBeNull();
 await expect(router.refresh('forgotten')).rejects.toThrow();
 await router.refresh('cb'); expect(cb.refresh).toHaveBeenCalledWith('cb'); expect(refreshRH).not.toHaveBeenCalled();
});


test('scheduled Coinbase sync covers all connected accounts, persists cadence and skips unavailable accounts', async () => {
 const f = await fixture();
 await f.service.start();
 const first = f.service.tick(); expect(f.service.tick()).toBe(first); await first;
 expect(f.readChat).toHaveBeenCalledTimes(2);
 await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(2);
 f.advance(15 * 60_000);
 f.list.mockResolvedValueOnce(f.ids.map((accountId, i) => ({accountId,label:'Synthetic',status:i === 0 ? 'connected' : 'disconnected'})));
 await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(3);
 expect(f.readChat.mock.calls[2][0].accountRef).toBe(f.ids[0]);
 // Restart recovery does not reset the persisted attempt time.
 await f.service.start(); await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(4);
 await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(4);
});

test('scheduled failures preserve good data, do not block another account and retry at a bounded cadence', async () => {
 const f = await fixture(); await f.service.tick(); f.advance(15 * 60_000);
 f.readChat.mockRejectedValueOnce(new CoinbaseError('provider'));
 await f.service.tick();
 expect((await f.service.snapshot(f.ids[0]))).toMatchObject({portfolio:{totalValue:'125'},resources:[{state:'failed',errorCode:'provider'}]});
 expect((await f.service.snapshot(f.ids[1])).resources[0].state).toBe('completed');
 await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(4);
 f.advance(15 * 60_000); await f.service.tick();
 expect((await f.service.snapshot(f.ids[0])).resources[0].state).toBe('completed');
});

test('Coinbase scheduling pauses for host maintenance and stops without starting another account', async () => {
 let unavailable = true; const f = await fixture(() => unavailable);
 await f.service.tick(); expect(f.readChat).not.toHaveBeenCalled();
 unavailable = false;
 let release!: () => void;
 f.readChat.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return {data:payload()}; });
 const work = f.service.tick(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
 expect(f.service.busy()).toBe(true);
 const closing = f.service.close(); release(); await closing; await work;
 expect(f.readChat).toHaveBeenCalledTimes(1);
 await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(1);
 await expect(f.service.refresh(f.ids[0])).rejects.toMatchObject({code:'cancelled'});
});

test('scope failures are recorded before any provider call and contention retries after one minute', async () => {
 const f = await fixture(); f.chatScope.mockRejectedValueOnce(new CoinbaseError('unavailable'));
 await expect(f.service.refresh(f.ids[0])).rejects.toMatchObject({code:'unavailable'});
 expect((await f.service.snapshot(f.ids[0])).resources[0]).toMatchObject({state:'failed',errorCode:'unavailable'});
 f.readChat.mockRejectedValueOnce(new CoinbaseError('busy'));
 await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(1);
 f.advance(59_000); await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(1);
 f.advance(1000); await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(3);
 expect(f.readChat.mock.calls.slice(1).map(call=>call[0].accountRef)).toEqual(f.ids);
});


test('a newly connected portfolio syncs immediately without re-reading a fresh existing account', async () => {
 const f = await fixture();
 f.list.mockResolvedValueOnce([{accountId:f.ids[0],label:'Existing',status:'connected'}]);
 await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(1);
 await f.service.tick(); expect(f.readChat).toHaveBeenCalledTimes(2);
 expect(f.readChat.mock.calls[1][0].accountRef).toBe(f.ids[1]);
 expect((await f.service.snapshot(f.ids[1])).portfolio?.totalValue).toBe('900');
});


test('history failures cannot invalidate balances and coverage remains account scoped',async()=>{
 const readHistory=vi.fn(async()=>({state:'partial' as const,reason:'access' as const,walletCount:1,completedWallets:0,transactions:[]}));
 const f=await fixture(()=>false,readHistory);
 await f.service.refresh(f.ids[0]);
 expect((await f.service.snapshot(f.ids[0])).coinbaseHistory).toMatchObject({state:'partial',issue:'access',transactionCount:0});
 expect((await f.service.snapshot(f.ids[1])).coinbaseHistory).toBeUndefined();
 readHistory.mockRejectedValueOnce(new CoinbaseError('provider'));
 await f.service.refresh(f.ids[0]);
 const view=await f.service.snapshot(f.ids[0]);
 expect(view.portfolio?.totalValue).toBe('125');expect(view.resources[0].state).toBe('completed');expect(view.coinbaseHistory?.state).toBe('failed');
});


test('account refresh syncs activity independently, reports failure and resumes partial backfills sooner',async()=>{
 const read=vi.fn(async()=>({orders:[],fills:[],cursor:null}));
 const f=await fixture(()=>false,undefined,read);
 await f.service.tick();
 expect(read).toHaveBeenCalledTimes(4);
 expect((await f.service.snapshot(f.ids[0])).resources.map(r=>r.state)).toEqual(['completed','completed','completed']);
 await f.db.query("UPDATE coinbase_activity_sync SET state='partial' WHERE account_id=$1 AND resource='spot_fills'",[f.ids[0]]);
 f.advance(60000);await f.service.tick();expect(read).toHaveBeenCalledTimes(6);
 read.mockRejectedValue(new Error('provider'));
 await f.service.refresh(f.ids[0]);
 const view=await f.service.snapshot(f.ids[0]);expect(view.portfolio?.totalValue).toBe('125');expect(view.resources.map(r=>r.state)).toEqual(['completed','failed','failed']);
});

test('wake refreshes healthy accounts promptly but preserves repeated-failure backoff across restart',async()=>{
 const f=await fixture();await f.service.tick();
 f.readChat.mockRejectedValueOnce(new CoinbaseError('provider'));
 await expect(f.service.refresh(f.ids[0])).rejects.toThrow();
 f.advance(60000);f.readChat.mockRejectedValueOnce(new CoinbaseError('provider'));await f.service.tick();
 let row=(await f.db.query<{failure_count:number;next_attempt_at:Date}>('SELECT failure_count,next_attempt_at FROM coinbase_portfolio_sync WHERE account_id=$1',[f.ids[0]])).rows[0];
 expect(row.failure_count).toBe(2);expect(row.next_attempt_at.getTime()-f.now()).toBe(120000);
 await f.service.start();f.service.suspend();const before=f.readChat.mock.calls.length;await f.service.wake();
 expect(f.readChat.mock.calls.slice(before).map(call=>call[0].accountRef)).toEqual([f.ids[1]]);
 f.advance(119999);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(before+1);
 f.advance(1);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(before+2);
 row=(await f.db.query<typeof row>('SELECT failure_count,next_attempt_at FROM coinbase_portfolio_sync WHERE account_id=$1',[f.ids[0]])).rows[0];expect(row.failure_count).toBe(0);
});

test('suspend fences an in-flight read even if wake arrives before that read returns',async()=>{
 const history=vi.fn(async()=>({state:'complete' as const,walletCount:0,completedWallets:0,transactions:[]}));
 const f=await fixture(()=>false,history);let release!:()=>void;
 f.readChat.mockImplementationOnce(async()=>{await new Promise<void>(r=>{release=r;});return {data:payload('999')};});
 const work=f.service.refresh(f.ids[0]);const rejected=expect(work).rejects.toMatchObject({code:'cancelled'});
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.service.suspend();
 await expect(f.service.refresh(f.ids[1])).rejects.toMatchObject({code:'cancelled'});
 const waking=f.service.wake();release();await rejected;await waking;
 expect((await f.db.query("SELECT 1 FROM coinbase_portfolio_observations WHERE data->'portfolio'->>'totalValue'='999'")).rows).toHaveLength(0);
 expect(history).toHaveBeenCalledTimes(2); // Only the fresh post-wake reads continue to history.
 expect((await f.service.snapshot(f.ids[0])).portfolio?.totalValue).toBe('125');
});

test('activity failures back off despite successful balance reads',async()=>{
 const read=vi.fn(async()=>{throw new CoinbaseError('provider');});const f=await fixture(()=>false,undefined,read);
 await f.service.tick();f.advance(60000);await f.service.tick();const calls=read.mock.calls.length;
 f.advance(60000);await f.service.tick();expect(read).toHaveBeenCalledTimes(calls);
 f.advance(60000);await f.service.tick();expect(read.mock.calls.length).toBeGreaterThan(calls);
 expect((await f.service.snapshot(f.ids[0])).portfolio?.totalValue).toBe('125');
});

test('suspend stops an activity page from continuing into another resource or history',async()=>{
 let release!:()=>void;
 const read=vi.fn(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {orders:[],fills:[],cursor:null};});
 const history=vi.fn(async()=>({state:'complete' as const,walletCount:0,completedWallets:0,transactions:[]}));
 const f=await fixture(()=>false,history,read);const work=f.service.refresh(f.ids[0]);const rejected=expect(work).rejects.toMatchObject({code:'cancelled'});
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.service.suspend();release();await rejected;
 expect(read).toHaveBeenCalledTimes(1);expect(history).not.toHaveBeenCalled();
});

test('recent orders poll every five seconds, slow after two minutes and preserve failure backoff',async()=>{
 const {randomUUID}=await import('node:crypto');const f=await fixture();await f.service.tick();
 const strategy=randomUUID(),version=randomUUID(),allocation=randomUUID(),order=randomUUID();
 await f.db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await f.db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners",[version,strategy]);
 await f.db.query('INSERT INTO coinbase_allocations(id,account_id,strategy_id,version_id,created_at) VALUES($1,$2,$3,$4,now())',[allocation,f.ids[0],strategy,version]);
 await f.db.query("INSERT INTO coinbase_allocation_orders(id,allocation_id,account_id,cause,request_hash,client_ref,product,side,max_base,state,created_at) VALUES($1,$2,$3,'synthetic','hash',$4,'BTC-USDC','buy',1,'unknown',$5)",[order,allocation,f.ids[0],randomUUID(),new Date(f.now()).toISOString()]);
 f.advance(4999);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(2);
 f.advance(1);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(3);expect(f.readChat.mock.calls[2][0].accountRef).toBe(f.ids[0]);
 f.readChat.mockRejectedValueOnce(new CoinbaseError('provider'));
 f.advance(5000);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(4);
 f.advance(59999);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(4);
 f.advance(1);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(5);
 f.advance(45000);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(6);
 f.advance(5000);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(6);
 f.advance(55000);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(7);
 await f.db.query("UPDATE coinbase_allocation_orders SET state='closed',closed_at=now() WHERE id=$1",[order]);
 f.advance(60000);await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(7);
});

test('persistent failure backoff caps at fifteen minutes',async()=>{
 const f=await fixture();f.readChat.mockRejectedValue(new CoinbaseError('provider'));
 for(const seconds of [60,120,240,480,900,900]){
  await expect(f.service.refresh(f.ids[0])).rejects.toThrow();
  const row=(await f.db.query<{next_attempt_at:Date}>('SELECT next_attempt_at FROM coinbase_portfolio_sync WHERE account_id=$1',[f.ids[0]])).rows[0];
  expect(row.next_attempt_at.getTime()-f.now()).toBe(seconds*1000);
 }
});

test('snapshot exposes stored historical movements only for their account, including partial coverage',async()=>{
 const f=await fixture();
 const transaction={id:'synthetic',wallet:'internal-wallet-hash',asset:'USDC',amount:'25',type:'receive',status:'completed',occurredAt:'2026-09-01T12:00:00Z'};
 await f.db.query("INSERT INTO coinbase_transaction_history(account_id,checked_at,state,error_code,data) VALUES($1,now(),'partial','page_limit',$2)",[f.ids[0],JSON.stringify({state:'partial',walletCount:1,completedWallets:0,transactions:[transaction]})]);
 const first=await f.service.snapshot(f.ids[0]),second=await f.service.snapshot(f.ids[1]);
 expect(first.accountTransactions).toHaveLength(1);expect(first.accountTransactions?.[0]).toMatchObject({id:'synthetic',amount:'25',asset:'USDC'});
 expect(first.accountTransactions?.[0]).not.toHaveProperty('wallet');expect(second.accountTransactions).toEqual([]);
 expect(first.coinbaseHistory?.state).toBe('partial');
});

test('asset products and candle cache misses use the connected MCP reader',async()=>{
 const f=await fixture(),account=f.ids[0],now=f.now();
 const read=vi.fn(async(_scope:unknown,name:string,args:Record<string,unknown>)=>({data:name==='coinbase_products_get'?{product_id:'BTC-USD',product_type:'SPOT',base_currency_id:'BTC',quote_currency_id:'USD',price:'500'}:{candles:Array.from({length:(Date.parse(String(args.end))-Date.parse(String(args.start)))/3600000},(_,i)=>({start:String((Date.parse(String(args.start))+i*3600000)/1000),open:'500',high:'501',low:'499',close:'500',volume:'1'}))}}));
 const metadata=vi.fn(async()=>({product_id:'BTC-USD' as string,high_24h:'510',low_24h:'490'}));
 const service=createCoinbasePortfolio({use:work=>work(f.db)},{list:async()=>[{accountId:account,capabilities:{accountRead:true}}],chatScope:f.chatScope,assertChatScope:f.assertChatScope,readChat:read,readProductMetadata:metadata} as unknown as Parameters<typeof createCoinbasePortfolio>[1],()=>now);
 expect((await service.markets.detail('BTC-USD',account)).market).toMatchObject({price:'500',high24h:'510',low24h:'490'});
 expect(read.mock.calls[0]).toEqual([expect.objectContaining({accountRef:account}),'coinbase_products_get',{product_id:'BTC-USD'}]);
 expect((await service.markets.series('BTC-USD','1d')).series?.points).toHaveLength(24);
 expect(read.mock.calls[1][1]).toBe('coinbase_products_candles');expect(read.mock.calls[1][2]).toMatchObject({granularity:'1h',limit:350});
 await service.markets.series('BTC-USD','1d');expect(read).toHaveBeenCalledTimes(2);
});

test('position costs preserve matching currencies, signed returns and missing cost basis',()=>{
 const positions=normalizeCoinbasePortfolio(payload()).spotPositions;
 const details={asset:'BTC',total_balance_crypto:1e-8,total_balance_fiat:'126',average_entry_price:{value:'100',currency:'USD'},cost_basis:{value:'150',currency:'USD'}};
 applyCoinbasePositionDetails(positions,[details]);expect(positions[0]).toMatchObject({averageEntryPrice:'100',unrealizedPnl:'-25'});
 const missing=normalizeCoinbasePortfolio(payload()).spotPositions;applyCoinbasePositionDetails(missing,[{...details,cost_basis:{value:'0',currency:'USD'},average_entry_price:{value:'100',currency:'EUR'}}]);
 expect(missing[0]).toMatchObject({averageEntryPrice:null,unrealizedPnl:null});
 const changed=normalizeCoinbasePortfolio(payload()).spotPositions;applyCoinbasePositionDetails(changed,[{...details,total_balance_crypto:'2'}]);expect(changed[0].averageEntryPrice).toBeUndefined();
});
test('position ownership comes only from the selected account ledger and hides unreconciled claims',async()=>{
 const f=await fixture();await f.service.refresh(f.ids[0]);await f.service.refresh(f.ids[1]);
 const ids=['00000000-0000-4000-8000-000000000101','00000000-0000-4000-8000-000000000102','00000000-0000-4000-8000-000000000103'];
 await f.db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[ids[0]]);
 await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{"title":"Recorded Take"}','{}','{}','{}' FROM local_owners`,[ids[1],ids[0]]);
 await f.db.query('INSERT INTO coinbase_allocations(id,account_id,strategy_id,version_id,created_at) VALUES($1,$2,$3,$4,now())',[ids[2],f.ids[0],ids[0],ids[1]]);
 await f.db.query(`INSERT INTO coinbase_allocation_entries(id,allocation_id,account_id,asset,quantity,cause,request_hash,kind,occurred_at) VALUES(gen_random_uuid(),$1,$2,'BTC',0.000000005,'fixture','fixture','capital',now())`,[ids[2],f.ids[0]]);
 expect((await f.service.snapshot(f.ids[0])).spotPositions?.[0].takeAllocations).toEqual([expect.objectContaining({strategyId:ids[0],title:'Recorded Take'})]);
 expect((await f.service.snapshot(f.ids[1])).spotPositions?.[0].takeAllocations).toEqual([]);
 const held=await f.service.snapshot(f.ids[0]);
 expect(held.strategies).toEqual([expect.objectContaining({allocationId:ids[2],title:'Recorded Take',requiresReconciliation:false,value:expect.any(String)})]);
 expect(held.selfDirectedSpotPositions?.[0].quantity).toBe('0.000000005');
 expect((await f.service.snapshot(f.ids[1])).strategies).toEqual([]);
 await f.db.query('UPDATE coinbase_allocations SET restore_required=true WHERE id=$1',[ids[2]]);
 expect((await f.service.snapshot(f.ids[0])).spotPositions?.[0].takeAllocations).toBeUndefined();
});

test('market reads coalesce identical in-flight requests without sharing account authority or retaining failures',async()=>{
 const f=await fixture();let release!:()=>void;
 const product={product_id:'BTC-USD',product_type:'SPOT',base_currency_id:'BTC',quote_currency_id:'USD',price:'500'};
 const read=vi.fn(async()=>({data:product}));read.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {data:product};});
 const service=createCoinbasePortfolio({use:work=>work(f.db)},{list:f.list,chatScope:f.chatScope,assertChatScope:f.assertChatScope,readChat:read} as unknown as Parameters<typeof createCoinbasePortfolio>[1]);
 const first=service.markets.detail('BTC-USD',f.ids[0]),same=service.markets.detail('BTC-USD',f.ids[0]),other=service.markets.detail('BTC-USD',f.ids[1]);
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));expect(service.busy()).toBe(true);release();
 await Promise.all([first,same,other]);expect(read).toHaveBeenCalledTimes(2);
 expect(f.chatScope.mock.calls.map(c=>c[0])).toEqual(f.ids);expect(service.busy()).toBe(false);
 read.mockRejectedValueOnce(new CoinbaseError('authentication'));
 await expect(service.markets.detail('BTC-USD',f.ids[0])).rejects.toMatchObject({code:'authentication'});
 await expect(service.markets.detail('BTC-USD',f.ids[0])).resolves.toMatchObject({market:{price:'500'}});
 await service.close();
});

test('market reads reject results and queued requests across suspend wake and shutdown',async()=>{
 const f=await fixture();let release!:()=>void;
 const read=vi.fn(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {data:{product_id:'BTC-USD',product_type:'SPOT',base_currency_id:'BTC',quote_currency_id:'USD',price:'500'}};});
 const metadata=vi.fn(async()=>({}));
 const service=createCoinbasePortfolio({use:work=>work(f.db)},{list:async()=>[],chatScope:f.chatScope,assertChatScope:f.assertChatScope,readChat:read,readProductMetadata:metadata} as unknown as Parameters<typeof createCoinbasePortfolio>[1]);
 const results=Promise.allSettled([service.markets.detail('BTC-USD',f.ids[0]),service.markets.detail('ETH-USD',f.ids[0])]);
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));service.suspend();const wake=service.wake();release();await wake;
 expect((await results).map(r=>r.status==='rejected'&&r.reason.code)).toEqual(['cancelled','cancelled']);expect(read).toHaveBeenCalledTimes(1);expect(metadata).not.toHaveBeenCalled();
 release=undefined as unknown as ()=>void;
 const closingRead=expect(service.markets.detail('BTC-USD',f.ids[0])).rejects.toMatchObject({code:'cancelled'});
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));let closed=false;const closing=service.close().then(()=>{closed=true;});
 expect(closed).toBe(false);release();await closingRead;await closing;expect(service.busy()).toBe(false);
 await expect(service.markets.detail('BTC-USD',f.ids[0])).rejects.toMatchObject({code:'cancelled'});
});

test('market read queue is bounded and rechecks authority after provider completion',async()=>{
 const f=await fixture();let release!:()=>void;
 const read=vi.fn(async()=>{await new Promise<void>(resolve=>{release=resolve;});return {data:{}};});
 const service=createCoinbasePortfolio({use:work=>work(f.db)},{list:f.list,chatScope:f.chatScope,assertChatScope:f.assertChatScope,readChat:read} as unknown as Parameters<typeof createCoinbasePortfolio>[1]);
 const pending=Promise.allSettled(Array.from({length:32},(_,i)=>service.markets.detail(`ASSET${i}-USD`,f.ids[0])));
 const duplicate=Promise.allSettled([service.markets.detail('ASSET0-USD',f.ids[0])]);
 await expect(service.markets.detail('OVERFLOW-USD',f.ids[0])).rejects.toMatchObject({code:'busy'});
 await vi.waitFor(()=>expect(release).toBeTypeOf('function'));service.suspend();release();await pending;
 expect((await duplicate)[0].status).toBe('rejected');expect(read).toHaveBeenCalledTimes(1);await service.close();
 const revoked=createCoinbasePortfolio({use:work=>work(f.db)},{list:f.list,chatScope:f.chatScope,assertChatScope:async()=>{throw new CoinbaseError('unavailable');},readChat:async()=>({data:{}})} as unknown as Parameters<typeof createCoinbasePortfolio>[1]);
 await expect(revoked.markets.detail('BTC-USD',f.ids[0])).rejects.toMatchObject({code:'unavailable'});await revoked.close();
});

test('saved holdings across accounts drive public demand and live valuation without changing observations', async()=>{
 const f=await fixture(()=>false,undefined,undefined,product=>product==='BTC-USD'?'10000000000':null);
 await f.service.refresh(f.ids[0]);await f.service.refresh(f.ids[1]);
 f.readChat.mockClear();
 expect(await f.service.heldProducts()).toEqual(['BTC-USD','BTC-USD']);
 const view=await f.service.snapshot(f.ids[0]);
 expect(view.spotPositions?.[0].marketValue).toBe('100');
 expect(view.portfolio?.totalValue).toBe('100');
 expect(view.accounts.map(a=>a.balance?.totalValue)).toEqual(['100','100']);
 expect(view.history.at(-1)?.totalValue).toBe('125');
 expect((await f.db.query<{data:{portfolio:{totalValue:string}}}>('SELECT data FROM coinbase_portfolio_observations WHERE account_id=$1',[f.ids[0]])).rows[0].data.portfolio.totalValue).toBe('125');
 expect(f.readChat).not.toHaveBeenCalled();
 await f.db.query("UPDATE platform_connections SET status='disconnected'");
 expect(await f.service.heldProducts()).toEqual([]);
 f.advance(900001);
 expect((await f.service.snapshot(f.ids[0])).portfolio?.totalValue).toBe('125');
});

test('holdings demand excludes hidden dust per account and follows preference changes without changing totals',async()=>{
 let policy={hide:true,threshold:'0.10'};
 const f=await fixture(()=>false,undefined,undefined,undefined,()=>policy);
 await f.service.refresh(f.ids[0]);await f.service.refresh(f.ids[1]);
 await f.db.query("UPDATE coinbase_portfolio_observations SET data=jsonb_set(data,'{spotPositions,0,marketValue}',to_jsonb($2::text)) WHERE account_id=$1",[f.ids[0],'0.05']);
 expect(await f.service.heldProducts()).toEqual(['BTC-USD']);
 expect((await f.service.snapshot(f.ids[0])).spotPositions).toHaveLength(1);
 expect((await f.service.snapshot(f.ids[0])).portfolio?.totalValue).toBe('125');
 policy={hide:false,threshold:'0.10'};
 expect(await f.service.heldProducts()).toEqual(['BTC-USD','BTC-USD']);
 policy={hide:true,threshold:'1000'};
 expect(await f.service.heldProducts()).toEqual([]);
 policy={hide:true,threshold:'0.05'};
 expect(await f.service.heldProducts()).toEqual(['BTC-USD','BTC-USD']);
 f.readChat.mockClear();await f.service.heldProducts();expect(f.readChat).not.toHaveBeenCalled();
});


test('account feed policy isolates background reads while required refresh retains complete reads',async()=>{
 const activity=vi.fn(async()=>({orders:[],fills:[],cursor:null}));
 const history=vi.fn(async()=>{throw Error('fixture history unavailable');});
 let allowed='';
 const f=await fixture(()=>false,history,activity,undefined,undefined,{
  backgroundAllowed:async id=>id===allowed,
  config:async()=>({reads:{portfolio:true,positionDetails:false,orders:true,fills:false,history:false}}),
 });allowed=f.ids[0];
 await f.service.tick();expect(f.readChat).toHaveBeenCalledTimes(1);expect(f.readChat.mock.calls[0][0].accountRef).toBe(allowed);
 expect(activity.mock.calls).toHaveLength(1);expect((activity.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({resource:'spot_orders'});expect(history).not.toHaveBeenCalled();
 activity.mockClear();await f.service.refresh(f.ids[1]);
 expect(f.readChat).toHaveBeenCalledTimes(2);expect(activity.mock.calls).toHaveLength(2);expect(history).toHaveBeenCalledTimes(1);
});

test('disabled balance feed preserves saved observations instead of recording empty holdings',async()=>{
 const activity=vi.fn(async()=>({orders:[],fills:[],cursor:null}));
 const f=await fixture(()=>false,undefined,activity,undefined,undefined,{config:async()=>({reads:{portfolio:false,positionDetails:false,orders:true,fills:false,history:false}})});
 await f.service.refresh(f.ids[0]);const before=(await f.db.query('SELECT * FROM coinbase_portfolio_observations')).rows;
 f.readChat.mockClear();activity.mockClear();await f.service.refresh(f.ids[0],'background');
 expect(f.readChat).not.toHaveBeenCalled();expect(activity).toHaveBeenCalledTimes(1);
 expect((await f.db.query('SELECT * FROM coinbase_portfolio_observations')).rows).toEqual(before);
});

test('required refresh waits for reduced background work then performs its own complete refresh',async()=>{
 const f=await fixture(()=>false,undefined,undefined,undefined,undefined,{config:async()=>({reads:{portfolio:true,positionDetails:false,orders:false,fills:false,history:false}})});
 let release!:(value:{data:ReturnType<typeof payload>})=>void;
 f.readChat.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
 const background=f.service.refresh(f.ids[0],'background');
 while(!release)await new Promise(resolve=>setTimeout(resolve,1));
 const required=f.service.refresh(f.ids[0]);release({data:payload()});await Promise.all([background,required]);
 expect(f.readChat).toHaveBeenCalledTimes(2);
});
test('portfolio chart history includes complete sampled valuations, never incomplete ones or altered holdings',async()=>{
 const f=await fixture();await f.service.refresh(f.ids[0]);const time=f.now();
 await f.db.query(`INSERT INTO coinbase_valuation_snapshots(account_id,bucket,observed_at,holdings_observed_at,source_revision,quality,reason,total_value,currency,prices)
 VALUES($1,$2,$2,$3,1,'complete',NULL,'150','USD','[]'),($1,$4,$4,$3,1,'incomplete','missing_price',NULL,'USD','[]')`,[f.ids[0],new Date(time+60000),new Date(time),new Date(time+120000)]);
 f.advance(180000);const view=await f.service.snapshot(f.ids[0]);
 expect(view.history).toEqual([{observedAt:new Date(time+60000).toISOString(),totalValue:'150',currency:'USD'}]);
 expect(view.portfolio?.totalValue).toBe('125');expect(view.spotPositions?.[0].marketValue).toBe('125');
});
