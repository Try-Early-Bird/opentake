import { afterEach, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate, migrations, prepareRestoredDatabase } from '../../src/main/migrations';
import { createCoinbaseConnections } from '../../src/main/coinbase/connections';
import { parseCoinbaseKey, readCoinbaseKeyFile } from '../../src/main/coinbase/key';
import { CoinbaseError } from '../../src/main/coinbase/errors';
import { coinbaseChildEnvironment, type CoinbaseSessionFactory } from '../../src/main/coinbase/client';
import type { SecretStore } from '../../src/main/secret-store';

const key = () => ({ name: 'organizations/synthetic/apiKeys/test', privateKey: generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'sec1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey });
const one = '00000000-0000-4000-8000-000000000001', two = '00000000-0000-4000-8000-000000000002';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(historyReader?: import('../../src/main/coinbase/history').CoinbaseHistoryRead, activityReader?: import('../../src/main/coinbase/activity').ActivityRead, previewReader?: typeof import('../../src/main/coinbase/rest').coinbasePreviewPost, submitReader?: typeof import('../../src/main/coinbase/rest').coinbaseOrderPost, cancelReader?: typeof import('../../src/main/coinbase/rest').coinbaseCancelPost, portfolioReader?: typeof import('../../src/main/coinbase/rest').coinbasePortfolioGet, productReader?: typeof import('../../src/main/coinbase/rest').coinbaseProductGet) {
  const db = new PGlite(); cleanups.push(() => db.close()); await migrate(db);
  const values = new Map<string, string>(); let available = true;
  const secrets: SecretStore = { available: () => available, get: async ref => values.get(ref) ?? null, has: async ref => values.has(ref), set: async (ref, value) => { values.set(ref, value); }, delete: async ref => { values.delete(ref); } };
  const calls: { name: string; args: unknown }[] = [];
  const state = { portfolio: one, trade: true, transfer: false, view: true, failure: undefined as CoinbaseError | undefined, detail: undefined as string | undefined, incomplete: false, closed: 0 };
  const factory: CoinbaseSessionFactory = async () => ({
    async read(name, args) {
      calls.push({ name, args }); if (state.failure) throw state.failure;
      if (name === 'coinbase_api_key_permissions') return state.incomplete ? { can_view: true } : { can_view: state.view, can_trade: state.trade, can_transfer: state.transfer, portfolio_uuid: state.portfolio, portfolio_type: 'CONSUMER' };
      if (name === 'coinbase_orders_list') return { orders: [], cursor: 'next-page', has_next: true };
      if (name === 'coinbase_orders_fills') return { fills: [] };
      const p = { uuid: state.portfolio, name: 'Agent portfolio', type: 'CONSUMER', deleted: false };
      if (name === 'coinbase_portfolios_list') return { portfolios: [p, { ...p, uuid: state.portfolio === one ? two : one }] };
      return { portfolio: { ...p, uuid: state.detail ?? state.portfolio }, spot_positions: [] };
    }, async close() { state.closed++; },
  });
  const database = { use: <T>(work: (db: PGlite) => Promise<T>) => work(db) };
  const synthetic = key();
  const make = () => createCoinbaseConnections(database, secrets, factory, async () => synthetic, historyReader, activityReader, previewReader, submitReader, cancelReader, productReader, portfolioReader);
  const service = make(); cleanups.push(() => service.close());
  return { db, values, secrets, state, calls, service, make, synthetic, lock: () => { available = false; }, unlock: () => { available = true; }, database };
}

test('two Coinbase scopes coexist with Robinhood and expose no key or raw portfolio ID', async () => {
  const f = await fixture();
  await f.db.exec("INSERT INTO platform_connections(owner_id,venue,status) SELECT id,'robinhood','connected' FROM local_owners");
  const first = (await f.service.importKey('/synthetic.json', { readOnly: false }))[0];
  f.state.portfolio = two;
  const all = await f.service.importKey('/synthetic.json', { readOnly: false, label: 'Second' });
  expect(all).toHaveLength(2); expect(new Set(all.map(a => a.accountId)).size).toBe(2);
  expect(first).toMatchObject({ status: 'connected', permissions: { view: true, trade: true, transfer: false }, capabilities: { trading: false, chat: true } });
  expect(JSON.stringify(all)).not.toContain(f.synthetic.privateKey); expect(JSON.stringify(all)).not.toContain(one);
  expect(f.calls.filter(c => c.name === 'coinbase_portfolios_get').map(c => c.args)).toEqual([{ portfolio_id: one }, { portfolio_id: two }]);
  const stored = await f.db.query('SELECT * FROM platform_connections');
  expect(stored.rows).toHaveLength(3); expect(JSON.stringify(stored)).not.toContain(f.synthetic.privateKey);
  expect(f.state.closed).toBe(2);
});

test('rejects transfer, missing view, incomplete permissions and wrong portfolio detail before saving', async () => {
  const f = await fixture();
  f.state.transfer = true;
  await expect(f.service.importKey('/synthetic.json', { readOnly: false })).rejects.toMatchObject({ code: 'permissions' });
  f.state.transfer = false; f.state.view = false;
  await expect(f.service.importKey('/synthetic.json', { readOnly: false })).rejects.toMatchObject({ code: 'permissions' });
  f.state.view = true; f.state.incomplete = true;
  await expect(f.service.importKey('/synthetic.json', { readOnly: false })).rejects.toMatchObject({ code: 'permissions' });
  f.state.incomplete = false; f.state.detail = two;
  await expect(f.service.importKey('/synthetic.json', { readOnly: false })).rejects.toMatchObject({ code: 'scope' });
  expect(f.values.size).toBe(0); expect(await f.service.list()).toEqual([]);
});

test('View-only is an explicit option and never reports trading capability', async () => {
  const f = await fixture(); f.state.trade = false;
  await expect(f.service.importKey('/synthetic.json', { readOnly: false })).rejects.toMatchObject({ code: 'permissions' });
  expect((await f.service.importKey('/synthetic.json', { readOnly: true }))[0]).toMatchObject({ permissions: { trade: false }, capabilities: { trading: false } });
});

test('duplicate import and failed/wrong-scope replacement preserve the working connection and key', async () => {
  const f = await fixture(); const original = (await f.service.importKey('/synthetic.json', { readOnly: false }))[0]; const before = new Map(f.values);
  await expect(f.service.importKey('/synthetic.json', { readOnly: false })).rejects.toMatchObject({ code: 'duplicate' });
  f.state.failure = new CoinbaseError('provider');
  await expect(f.service.importKey('/synthetic.json', { connectionId: original.connectionId, readOnly: false })).rejects.toMatchObject({ code: 'provider' });
  f.state.failure = undefined; f.state.portfolio = two;
  await expect(f.service.importKey('/synthetic.json', { connectionId: original.connectionId, readOnly: false })).rejects.toMatchObject({ code: 'wrong_account' });
  expect(await f.service.list()).toEqual([original]); expect(f.values).toEqual(before);
  f.state.portfolio = one;
  const replaced = (await f.service.importKey('/synthetic.json', { connectionId: original.connectionId, label: 'Renamed', readOnly: false }))[0];
  expect(replaced.accountId).toBe(original.accountId); expect(replaced.connectionId).toBe(original.connectionId);
  expect(replaced.label).toBe('Renamed'); expect(f.values.size).toBe(1); expect([...f.values.keys()]).not.toEqual([...before.keys()]);
});

test('restart, independent disconnect, and reconnect preserve financial account identity', async () => {
  const f = await fixture(); const original = (await f.service.importKey('/synthetic.json', { readOnly: false }))[0];
  f.state.portfolio = two; await f.service.importKey('/synthetic.json', { readOnly: false });
  await f.service.close(); const next = f.make(); cleanups.push(() => next.close());
  expect((await next.list()).filter(i => i.status === 'connected')).toHaveLength(2);
  await next.disconnect(original.connectionId);
  expect((await next.list()).filter(i => i.status === 'connected')).toHaveLength(1); expect(f.values.size).toBe(1);
  f.state.portfolio = one;
  expect((await next.importKey('/synthetic.json', { readOnly: false })).find(i => i.connectionId === original.connectionId)?.accountId).toBe(original.accountId);
});

test('refresh marks rejected credentials for repair, transient errors retain cache, locked storage blocks imports', async () => {
  const f = await fixture(); const original = (await f.service.importKey('/synthetic.json', { readOnly: false }))[0];
  f.state.failure = new CoinbaseError('provider');
  await expect(f.service.refresh(original.connectionId)).rejects.toMatchObject({ code: 'provider' });
  expect((await f.service.list())[0]).toMatchObject({ status: 'connected', checkedAt: original.checkedAt });
  f.state.failure = new CoinbaseError('authentication');
  await expect(f.service.refresh(original.connectionId)).rejects.toMatchObject({ code: 'authentication' });
  expect((await f.service.list())[0].status).toBe('reauth_required'); expect(f.values.size).toBe(1);
  f.state.failure = undefined; await f.service.refresh(original.connectionId); f.lock();
  expect((await f.service.list())[0].status).toBe('storage_locked');
  await expect(f.service.importKey('/synthetic.json', { readOnly: false })).rejects.toMatchObject({ code: 'storage_locked' });
});

test('restored references cannot reactivate same-device keys and reconnect retains IDs', async () => {
  const f = await fixture(); const original = (await f.service.importKey('/synthetic.json', { readOnly: false }))[0];
  await prepareRestoredDatabase(f.db);
  expect((await f.service.list())[0].status).toBe('reauth_required');
  await expect(f.service.refresh(original.connectionId)).rejects.toMatchObject({ code: 'unavailable' });
  const reconnected = (await f.service.importKey('/synthetic.json', { readOnly: false }))[0];
  expect(reconnected.accountId).toBe(original.accountId);
});

test('cancellation prevents persistence, closes the session and drops queued mutation', async () => {
  const f = await fixture(); let reached!: () => void; const ready = new Promise<void>(resolve => { reached = resolve; }); let closed = false;
  const service = createCoinbaseConnections(f.database, f.secrets, async () => ({
    read: async (_name, _args, signal) => { reached(); await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }); }); return {}; },
    close: async () => { closed = true; },
  }), async () => f.synthetic);
  cleanups.push(() => service.close());
  const pending = service.importKey('/synthetic.json', { readOnly: false }); const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  await ready; const queued = expect(service.importKey('/synthetic.json', { readOnly: false })).rejects.toMatchObject({ code: 'cancelled' });
  expect(service.queueStats().queued).toBe(1);
  await service.cancel(); await rejected; await queued; expect(closed).toBe(true); expect(f.values.size).toBe(0);
});

test('migration preserves legacy account data and permits multiple unique Coinbase portfolios', async () => {
  const db = new PGlite(); cleanups.push(() => db.close()); await migrate(db, migrations.filter(m => m.version < 47));
  await db.exec("INSERT INTO platform_connections(owner_id,venue) SELECT id,'robinhood' FROM local_owners; INSERT INTO linked_accounts(connection_id,external_ref,masked_number,selected) SELECT id,'legacy','fixture',true FROM platform_connections;");
  const before = (await db.query('SELECT * FROM linked_accounts')).rows;
  await migrate(db); expect((await db.query('SELECT * FROM linked_accounts')).rows).toEqual(before);
  await expect(db.exec("INSERT INTO platform_connections(owner_id,venue) SELECT id,'robinhood' FROM local_owners")).rejects.toThrow();
  await db.exec(`INSERT INTO platform_connections(owner_id,venue,external_account_ref) SELECT id,'coinbase','${one}' FROM local_owners`);
  await expect(db.exec(`INSERT INTO platform_connections(owner_id,venue,external_account_ref) SELECT id,'coinbase','${one}' FROM local_owners`)).rejects.toThrow();
});

test('key parser accepts only bounded P-256 key JSON and file reader does not follow symlinks', async () => {
  const synthetic = key(); expect(parseCoinbaseKey(JSON.stringify(synthetic)).name).toBe(synthetic.name);
  for (const raw of ['invalid', '{}', JSON.stringify({ ...synthetic, privateKey: 'synthetic-not-a-key' }), 'x'.repeat(17000)]) expect(() => parseCoinbaseKey(raw)).toThrow('ECDSA');
  const root = await mkdtemp(join(tmpdir(), 'coinbase-key-test-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'synthetic.json'); await writeFile(path, JSON.stringify(synthetic)); expect((await readCoinbaseKeyFile(path)).name).toBe(synthetic.name);
  if (process.platform !== 'win32') { await symlink(path, join(root, 'link.json')); await expect(readCoinbaseKeyFile(join(root, 'link.json'))).rejects.toThrow('ECDSA'); }
  await writeFile(path, 'x'.repeat(17000)); await expect(readCoinbaseKeyFile(path)).rejects.toThrow('ECDSA');
});

test('child environment excludes ambient credentials, endpoints and runtime injection', () => {
  const env = coinbaseChildEnvironment('/synthetic-home', key(), { PATH: '/test', NODE_OPTIONS: '--import attacker', COINBASE_URL: 'https://wrong.invalid', COINBASE_CONFIG_DIR: '/real', OTHER_TOKEN: 'synthetic' });
  expect(env).toMatchObject({ HOME: '/synthetic-home', COINBASE_CONFIG_DIR: '/synthetic-home', COINBASE_TRANSPORT: 'brokerage', ELECTRON_RUN_AS_NODE: '1', COINBASE_NO_HISTORY: '1' });
  expect(env).not.toHaveProperty('NODE_OPTIONS'); expect(env).not.toHaveProperty('COINBASE_URL'); expect(env).not.toHaveProperty('OTHER_TOKEN');
});

test('import progress reports actual host stages and clears after success or failure', async () => {
  const f = await fixture();
  const seen: unknown[] = [];
  let service: ReturnType<typeof createCoinbaseConnections>;
  const factory: CoinbaseSessionFactory = async () => ({
    async read(name) {
      seen.push(service.importProgress());
      const portfolio = { uuid: one, name: 'Synthetic', type: 'CONSUMER' };
      if (name === 'coinbase_api_key_permissions') return { can_view: true, can_trade: true, can_transfer: false, portfolio_uuid: one, portfolio_type: 'CONSUMER' };
      if (name === 'coinbase_portfolios_list') return { portfolios: [portfolio] };
      return { portfolio };
    }, async close() {},
  });
  const store = { ...f.secrets, set: async (ref: string, value: string) => { seen.push(service.importProgress()); await f.secrets.set(ref, value); } };
  service = createCoinbaseConnections(f.database, store, factory, async () => { seen.push(service.importProgress()); return f.synthetic; });
  expect(service.importProgress()).toBeNull();
  await service.importKey('/synthetic.json', { readOnly: false });
  expect(seen).toEqual(['key', 'permissions', 'portfolio', 'portfolio', 'saving']);
  expect(service.importProgress()).toBeNull();
  await expect(service.importKey('/synthetic.json', { readOnly: true })).rejects.toMatchObject({ code: 'permissions' });
  expect(service.importProgress()).toBeNull();
  await service.close();
});

test('chat binds reads to one account, rejects scope injection, and revokes snapshots after rotation or disconnect', async () => {
  const f = await fixture();
  const first = (await f.service.importKey('/synthetic.json', { readOnly: false }))[0];
  const scope = await f.service.chatScope(first.accountId);
  f.state.portfolio = two;
  const second = (await f.service.importKey('/synthetic.json', { readOnly: false })).find(a => a.accountId !== first.accountId)!;
  const other = await f.service.chatScope(second.accountId);
  f.calls.length = 0;
  await expect(f.service.readChat(scope, 'coinbase_orders_list', { portfolio_id: two })).rejects.toThrow();
  await expect(f.service.readChat(scope, 'coinbase_orders_create', {})).rejects.toMatchObject({ code: 'contract' });
  expect(f.calls).toEqual([]);
  // Wrong portfolio returned by permission introspection never reaches an account read.
  await expect(f.service.readChat(scope, 'coinbase_orders_list', {})).rejects.toMatchObject({ code: 'permissions' });
  expect(f.calls.map(c => c.name)).toEqual(['coinbase_api_key_permissions']);
  f.state.portfolio = one;
  const result = await f.service.readChat(scope, 'coinbase_orders_list', {});
  expect(f.calls.at(-1)).toEqual({ name: 'coinbase_orders_list', args: { portfolio_id: one, product_type: 'SPOT', limit: 50 } });
  expect(result.source).toMatchObject({ accountRef: first.accountId, accountLabel: first.label, platform: 'coinbase' });
  expect(result.coverage).toContain('One bounded page');
  expect(JSON.stringify(result)).not.toContain(one);
  await f.service.importKey('/synthetic.json', { connectionId: first.connectionId, readOnly: false });
  await expect(f.service.assertChatScope(scope)).rejects.toMatchObject({ code: 'unavailable' });
  f.state.portfolio = two;
  await expect(f.service.readChat(other, 'coinbase_portfolios_get', {})).resolves.toMatchObject({ source: { accountRef: second.accountId } });
  await f.service.disconnect(second.connectionId);
  await expect(f.service.readChat(other, 'coinbase_products_get', { product_id: 'BTC-USD' })).rejects.toMatchObject({ code: 'unavailable' });
});

test('chat rejects permission escalation and foreign portfolio results, redacts key strings and honors cancellation', async () => {
  const f = await fixture();
  const account = (await f.service.importKey('/synthetic.json', { readOnly: false }))[0];
  const scope = await f.service.chatScope(account.accountId);
  f.state.transfer = true;
  await expect(f.service.readChat(scope, 'coinbase_portfolios_get', {})).rejects.toMatchObject({ code: 'permissions' });
  f.state.transfer = false; f.state.detail = two;
  await expect(f.service.readChat(scope, 'coinbase_portfolios_get', {})).rejects.toMatchObject({ code: 'scope' });
  let result: unknown = { fills: [], description: `${f.synthetic.privateKey} ${f.synthetic.name}`, api_key: 'unexpected', portfolio_id: one, cursor: 'next-page' };
  const service = createCoinbaseConnections(f.database, f.secrets, async () => ({
    async read(name) { return name === 'coinbase_api_key_permissions' ? { can_view: true, can_trade: true, can_transfer: false, portfolio_uuid: one, portfolio_type: 'CONSUMER' } : result; }, async close() {},
  })); cleanups.push(() => service.close());
  const safe = await service.readChat(scope, 'coinbase_orders_fills', {});
  expect(JSON.stringify(safe)).not.toContain('PRIVATE KEY'); expect(JSON.stringify(safe)).not.toContain(f.synthetic.name);
  expect(safe.data).toMatchObject({ portfolio_id: account.accountId, api_key: '[redacted]', cursor: 'next-page' });
  result = { fills: [{ retail_portfolio_id: two }] };
  await expect(service.readChat(scope, 'coinbase_orders_fills', {})).rejects.toMatchObject({ code: 'scope' });
  const controller = new AbortController(); controller.abort();
  await expect(service.readChat(scope, 'coinbase_orders_fills', {}, controller.signal)).rejects.toMatchObject({ code: 'cancelled' });
});


test('history rechecks read-only portfolio permissions and refuses stale key authority', async () => {
  let reads=0;
  const f=await fixture(async (_key,portfolio,signal)=>{signal.throwIfAborted();expect(portfolio).toBe(one);reads++;return {state:'complete',reason:null,walletCount:1,completedWallets:1,transactions:[]};});
  f.state.trade=false;
  const account=(await f.service.importKey('/synthetic.json',{readOnly:true}))[0];
  const scope=await f.service.chatScope(account.accountId);
  await expect(f.service.readHistory(scope)).resolves.toMatchObject({state:'complete'});
  f.state.transfer=true;
  await expect(f.service.readHistory(scope)).rejects.toMatchObject({code:'permissions'});
  expect(reads).toBe(1);f.state.transfer=false;
  await f.service.importKey('/synthetic.json',{connectionId:account.connectionId,readOnly:true});
  await expect(f.service.readHistory(scope)).rejects.toMatchObject({code:'unavailable'});expect(reads).toBe(1);
});


test('activity reads recheck read-only permissions and reject stale authority before fetching', async () => {
 let reads=0;
 const f=await fixture(undefined,async(_key,portfolio,signal,args)=>{signal.throwIfAborted();expect(portfolio).toBe(one);expect(args.resource).toBe('spot_fills');reads++;return {orders:[],fills:[],cursor:null};});
 f.state.trade=false;
 const account=(await f.service.importKey('/synthetic.json',{readOnly:true}))[0];
 const scope=await f.service.chatScope(account.accountId),request={resource:'spot_fills' as const,until:'2026-10-09T00:00:00Z'};
 await f.service.readActivity(scope,request);expect(reads).toBe(1);
 f.state.portfolio=two;await expect(f.service.readActivity(scope,request)).rejects.toMatchObject({code:'permissions'});expect(reads).toBe(1);
 f.state.portfolio=one;f.state.transfer=true;await expect(f.service.readActivity(scope,request)).rejects.toMatchObject({code:'permissions'});expect(reads).toBe(1);
 f.state.transfer=false;await f.service.importKey('/synthetic.json',{connectionId:account.connectionId,readOnly:true});
 await expect(f.service.readActivity(scope,request)).rejects.toMatchObject({code:'unavailable'});expect(reads).toBe(1);
});

test('order preview uses only the bound portfolio and rejects permission drift before requests',async()=>{
 const bodies:unknown[]=[];
 const f=await fixture(undefined,undefined,async(_key,_signal,body)=>{bodies.push(body);return {preview_id:'synthetic-preview',commission_total:'1',errs:[]};});
 const account=(await f.service.importKey('/synthetic.json',{readOnly:false}))[0],scope=await f.service.chatScope(account.accountId);
 const orders=[{product:'BTC-USDC',side:'buy' as const,baseSize:'0.01',limitPrice:'100',notional:'1'}];
 await f.service.previewOrders(scope,orders);
 expect(bodies).toEqual([{retail_portfolio_id:one,product_id:'BTC-USDC',side:'BUY',order_configuration:{limit_limit_gtc:{base_size:'0.01',limit_price:'100',post_only:false}}}]);
 f.state.trade=false;await expect(f.service.previewOrders(scope,orders)).rejects.toMatchObject({code:'permissions'});
 f.state.trade=true;f.state.portfolio=two;await expect(f.service.previewOrders(scope,orders)).rejects.toMatchObject({code:'permissions'});
 f.state.portfolio=one;f.state.transfer=true;await expect(f.service.previewOrders(scope,orders)).rejects.toMatchObject({code:'permissions'});
 expect(bodies).toHaveLength(1);
});


test('order submission binds portfolio and permissions before durable dispatch; cancellation validates its order',async()=>{
 const bodies:unknown[]=[],cancelBodies:unknown[]=[];let prepared=0;
 const request={product:'BTC-USDC',side:'buy' as const,baseSize:'0.01',limitPrice:'100',notional:'1',clientRef:'11111111-1111-4111-8111-111111111111',previewId:'synthetic-preview'};
 const f=await fixture(undefined,undefined,undefined,async(_key,_signal,body)=>{expect(prepared).toBe(1);bodies.push(body);return {success:true,success_response:{order_id:'synthetic-order',product_id:request.product,side:'BUY',client_order_id:request.clientRef}};},async(_key,_signal,body)=>{cancelBodies.push(body);return {results:[{order_id:'synthetic-order',success:true}]};});
 const account=(await f.service.importKey('/synthetic.json',{readOnly:false}))[0],scope=await f.service.chatScope(account.accountId);
 for(const field of ['trade','view','transfer','portfolio'] as const){
  const original=f.state[field];Object.assign(f.state,{[field]:field==='portfolio'?two:field==='transfer'});
  await expect(f.service.submitOrder(scope,request,async()=>{prepared++;})).rejects.toMatchObject({code:'permissions'});Object.assign(f.state,{[field]:original});
 }
 expect(prepared).toBe(0);expect(bodies).toHaveLength(0);
 await expect(f.service.submitOrder(scope,request,async()=>{prepared++;})).resolves.toEqual({state:'accepted',providerRef:'synthetic-order'});
 expect(bodies[0]).toEqual({retail_portfolio_id:one,product_id:'BTC-USDC',side:'BUY',client_order_id:request.clientRef,preview_id:request.previewId,order_configuration:{limit_limit_gtc:{base_size:'0.01',limit_price:'100',post_only:false}}});
 await expect(f.service.cancelOrder(scope,'synthetic-order',async()=>{})).resolves.toBe(true);expect(cancelBodies).toEqual([{order_ids:['synthetic-order']}]);
});

test('disconnect preserves credentials and account authority until every local order is reconciled',async()=>{
 const {randomUUID}=await import('node:crypto');const f=await fixture();
 const account=(await f.service.importKey('/synthetic.json',{readOnly:false}))[0];
 const strategy=randomUUID(),version=randomUUID(),allocation=randomUUID(),order=randomUUID();
 await f.db.query('INSERT INTO strategies(id,owner_id) SELECT $1,id FROM local_owners',[strategy]);
 await f.db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) SELECT $1,$2,id,1,1,'{}','{}','{}','{}' FROM local_owners",[version,strategy]);
 await f.db.query('INSERT INTO coinbase_allocations(id,account_id,strategy_id,version_id,created_at) VALUES($1,$2,$3,$4,now())',[allocation,account.accountId,strategy,version]);
 await f.db.query("INSERT INTO coinbase_allocation_orders(id,allocation_id,account_id,cause,request_hash,client_ref,product,side,max_base,state,created_at) VALUES($1,$2,$3,'synthetic','hash',$4,'BTC-USDC','buy',1,'prepared',now())",[order,allocation,account.accountId,randomUUID()]);
 for(const state of ['prepared','submitting','unknown','bound','reconciliation_required']){
  await f.db.query('UPDATE coinbase_allocation_orders SET state=$1 WHERE id=$2',[state,order]);
  await expect(f.service.disconnect(account.connectionId)).rejects.toMatchObject({code:'orders_pending'});
  expect(f.values.size).toBe(1);expect((await f.service.list())[0].status).toBe('connected');
 }
 await f.db.query("UPDATE coinbase_allocation_orders SET state='closed',closed_at=now() WHERE id=$1",[order]);
 await f.service.disconnect(account.connectionId);expect(f.values.size).toBe(0);expect((await f.service.list())[0].status).toBe('disconnected');
});

test('position detail supplement uses the selected scope and rejects another portfolio response',async()=>{
 let returned=one;const calls:string[]=[];
 const f=await fixture(undefined,undefined,undefined,undefined,undefined,async(_key,_signal,portfolio)=>{calls.push(portfolio);return {breakdown:{portfolio:{uuid:returned},spot_positions:[{asset:'BTC',total_balance_crypto:1,total_balance_fiat:125,cost_basis:{value:'100',currency:'USD'},account_uuid:'not-exposed'}]}};});
 const account=(await f.service.importKey('/synthetic.json',{readOnly:false}))[0],scope=await f.service.chatScope(account.accountId);
 const rows=await f.service.readPositionDetails(scope);expect(rows[0]).toMatchObject({asset:'BTC',cost_basis:{value:'100',currency:'USD'}});expect(rows[0]).not.toHaveProperty('account_uuid');expect(calls).toEqual([one]);
 returned=two;await expect(f.service.readPositionDetails(scope)).rejects.toThrow();
});

test('authenticated trading-rule supplement checks market identity and connection authority',async()=>{
 let wrong=false;const calls:string[]=[];
 const f=await fixture(undefined,undefined,undefined,undefined,undefined,undefined,async(_key,_signal,id)=>{
  calls.push(id);return {product_id:wrong?'ZEC-USDC':id,base_currency_id:'BTC',quote_currency_id:'USDC',product_type:'SPOT',price:'100',base_increment:'0.001',quote_increment:'0.01',price_increment:'0.01',base_min_size:'0.001',base_max_size:'1000',quote_min_size:'1',quote_max_size:'100000',is_disabled:false,trading_disabled:false,cancel_only:false,post_only:false,auction_mode:false,view_only:false,status:'online'};
 });
 const connection=(await f.service.importKey('/synthetic.json',{readOnly:false}))[0],scope=await f.service.chatScope(connection.accountId);
 expect(await f.service.readTradingRules(scope,'BTC-USDC')).toMatchObject({price_increment:'0.01',trading_disabled:false});
 await expect(f.service.readTradingRules({...scope,authority:'changed'},'BTC-USDC')).rejects.toMatchObject({code:'unavailable'});
 expect(calls).toEqual(['BTC-USDC']);wrong=true;
 await expect(f.service.readTradingRules(scope,'BTC-USDC')).rejects.toMatchObject({code:'provider'});
});

test('market preview and submission use cash-sized buys and base-sized sells',async()=>{
 const previews:unknown[]=[],submissions:unknown[]=[];
 const f=await fixture(undefined,undefined,async(_key,_signal,body)=>{previews.push(body);return {preview_id:'market-preview',commission_total:'0.01',errs:[]};},async(_key,_signal,body)=>{submissions.push(body);const b=body as {product_id:string;side:string;client_order_id:string};return {success:true,success_response:{order_id:'market-order',product_id:b.product_id,side:b.side,client_order_id:b.client_order_id}};});
 const account=(await f.service.importKey('/synthetic.json',{readOnly:false}))[0],scope=await f.service.chatScope(account.accountId);
 for(const side of ['buy','sell'] as const){const order={orderType:'market' as const,product:'BTC-USDC',side,baseSize:'0.01',limitPrice:'100',notional:'1'};await f.service.previewOrders(scope,[order]);await f.service.submitOrder(scope,{...order,clientRef:'11111111-1111-4111-8111-111111111111',previewId:'market-preview'},async()=>{});}
 for(const bodies of [previews,submissions]){
  expect(bodies[0]).toMatchObject({order_configuration:{market_market_ioc:{quote_size:'1'}}});
  expect(bodies[1]).toMatchObject({order_configuration:{market_market_ioc:{base_size:'0.01'}}});
  expect(JSON.stringify(bodies)).not.toContain('limit_price');
 }
});

test('shared queue cancels unsent reads while an active Coinbase submission records its outcome',async()=>{
 let started!:()=>void,release!:()=>void;
 const ready=new Promise<void>(r=>{started=r;}),hold=new Promise<void>(r=>{release=r;});
 const request={product:'BTC-USDC',side:'buy' as const,baseSize:'0.01',limitPrice:'100',notional:'1',clientRef:'11111111-1111-4111-8111-111111111111',previewId:'synthetic-preview'};
 const f=await fixture(undefined,undefined,undefined,async(_key,signal)=>{
  started();await hold;expect(signal.aborted).toBe(false);
  return {success:true,success_response:{order_id:'synthetic-order',product_id:request.product,side:'BUY',client_order_id:request.clientRef}};
 });
 const account=(await f.service.importKey('/synthetic.json',{readOnly:false}))[0],scope=await f.service.chatScope(account.accountId);
 const order=f.service.submitOrder(scope,request,async()=>{});await ready;
 const read=expect(f.service.readChat(scope,'coinbase_orders_fills',{})).rejects.toMatchObject({code:'cancelled'});
 expect(f.service.queueStats()).toMatchObject({running:'order',queued:1});
 const cancelled=f.service.cancel();release();
 await expect(order).resolves.toEqual({state:'accepted',providerRef:'synthetic-order'});
 await cancelled;await read;
 expect(f.service.queueStats()).toMatchObject({running:null,queued:0,cancelled:1});
});
