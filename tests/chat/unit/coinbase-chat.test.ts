import { expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../src/main/migrations';
import { createCoinbaseChat } from '../../../src/main/coinbase/chat';
import { createTakes } from '../../../src/main/takes';
import { createPlatformAccess } from '../../../src/main/platform-access';
import { createMcpManagement } from '../../../src/main/mcp-management';
import { callOpentakeTool } from '../../../src/main/opentake-mcp/server';
import { toolCatalog, parseRead } from '../../../src/main/opentake-mcp/catalog';
import { assertCoinbaseReadContract, checkedCoinbaseArgs, checkCoinbaseReadResult } from '../../../src/main/coinbase/read-tools';
import contracts from '../../../src/main/coinbase/read-contracts.json';
const builtin = '00000000-0000-4000-8000-000000000001';
const selection = { provider: 'claude' as const, model: 'synthetic' };
const scope = { accountRef: randomUUID(), label: 'Primary synthetic', authority: 'synthetic-revision' };
const other = { accountRef: randomUUID(), label: 'Second synthetic', authority: 'second-revision' };
async function settle(service: ReturnType<typeof createTakes>) { for (let i = 0; i < 100; i++) { if (!service.busy()) return; await new Promise(r => setTimeout(r, 5)); } throw Error('Response did not finish'); }

test('curated contracts fail closed on drift, unscoped requests, writes and unbounded reads', () => {
  const tools = toolCatalog().filter(t => t.name.startsWith('coinbase_'));
  expect(tools.map(t => t.name).sort()).toEqual(Object.keys(contracts).sort());
  expect(tools.every(t => t.annotations.readOnlyHint)).toBe(true);
  for (const [name, contract] of Object.entries(contracts)) {
    expect(() => assertCoinbaseReadContract(name, contract)).not.toThrow();
    expect(() => assertCoinbaseReadContract(name, { ...contract, annotations: { readOnlyHint: false } })).toThrow();
    expect(() => assertCoinbaseReadContract(name, { ...contract, inputSchema: {} })).toThrow();
    expect(() => parseRead(name, {})).toThrow();
  }
  for (const name of ['coinbase_orders_create','coinbase_portfolios_create','coinbase_set_env','coinbase_feedback','coinbase_x402_pay']) expect(() => checkedCoinbaseArgs(name, {}, scope.accountRef)).toThrow();
  expect(() => checkedCoinbaseArgs('coinbase_products_list', { limit: 101 }, scope.accountRef)).toThrow();
  expect(() => checkedCoinbaseArgs('coinbase_orders_list', { portfolio_id: other.accountRef }, scope.accountRef)).toThrow();
  expect(() => checkedCoinbaseArgs('coinbase_products_candles', { product_id: 'BTC-USD', start: '2026-01-02T00:00:00Z', end: '2026-01-01T00:00:00Z' }, scope.accountRef)).toThrow();
});

test('response snapshots keep the selected portfolio, hide unselected tools and preserve message labels', async () => {
  const db = new PGlite(); await migrate(db);
  const database = { use: async <T>(fn: (db: PGlite) => Promise<T>) => fn(db) };
  const prompts: string[] = [];
  const service = createTakes(database, async i => { prompts.push(i.instructions); i.text('Synthetic reply'); }, async () => ({ ok: true, source: 'runtime', models: [{ value: 'synthetic', label: 'Synthetic' }] }), async () => [{ name: 'coinbase_portfolios_get' }, { name: 'robinhood_get_portfolio' }], undefined, undefined, async ref => ref === scope.accountRef ? { ...scope } : ref === other.accountRef ? { ...other } : ref ? Promise.reject(Error('Unknown account')) : null);
  try {
    await service.start(); const takeId = await service.create();
    const send = async (ref?: string) => { await service.send({ requestId: randomUUID(), takeId, parentId: (await service.load(takeId)).headId, text: 'Read my balance', selection, coinbaseAccountRef: ref }); await settle(service); };
    await send(scope.accountRef); await send(other.accountRef); await send();
    const rows = (await db.query<{ configuration: any }>('SELECT configuration FROM take_runs ORDER BY created_at')).rows;
    expect(rows.map(r => r.configuration.coinbaseAccount?.accountRef ?? null)).toEqual([scope.accountRef, other.accountRef, null]);
    expect(rows[0].configuration.coinbaseAccount.authority).toBe(scope.authority);
    expect(rows[2].configuration.tools).toEqual([{ name: 'robinhood_get_portfolio' }]);
    expect(prompts[0]).toContain(scope.accountRef); expect(prompts[1]).toContain(other.accountRef);
    const messages = (await service.load(takeId)).messages;
    expect(messages.filter(m => m.role === 'assistant').map(m => m.coinbaseAccount?.label)).toEqual([scope.label, other.label, undefined]);
    expect(JSON.stringify(messages)).not.toContain(scope.authority);
    await expect(send(randomUUID())).rejects.toThrow('Unknown account');
    expect((await service.load(takeId)).messages).toHaveLength(6);
  } finally { await service.close(); await db.close(); }
});

test('gateway scopes Coinbase, audits reads, gates policy and rejects revoked accounts after approval; history remains platform data', async () => {
  const db = new PGlite(); await migrate(db);
  const database = { use: async <T>(fn: (db: PGlite) => Promise<T>) => fn(db) };
  let revoked = false;
  const read = vi.fn(async () => ({ source: { platform: 'coinbase', accountRef: scope.accountRef, accountLabel: scope.label, observedAt: new Date().toISOString(), tool: 'coinbase_portfolios_get', runtime: '0.0.10' }, coverage: 'Snapshot', data: { balance: '123' } }));
  const chat = createCoinbaseChat(database, { assertChatScope: async selected => { if (revoked || selected.accountRef !== scope.accountRef) throw Error('Revoked'); }, readChat: read });
  const access = createPlatformAccess(database, () => true, { accounts: async run => { const selected = await chat.scope(run); return selected ? ['coinbase:' + selected.accountRef] : []; }, pollMs: 5 });
  const secrets = { available: () => true, get: async () => null, has: async () => false, set: async () => {}, delete: async () => {} };
  const mcp = createMcpManagement(database, secrets, '/unused-synthetic-coinbase', () => true, (name, args, signal, run) => callOpentakeTool({ status: () => chat.status(run), read: (_platform, tool, input, ref) => chat.read(run, tool, input, ref, signal) }, name, args), undefined, { beforeBuiltin: run => access.ensure(run), pollMs: 5 });
  try {
    await mcp.start(); const take = randomUUID();
    await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Synthetic','{}' FROM local_owners", [take]);
    const run = async (selected: typeof scope | null = scope, provider = 'claude') => { const id = randomUUID(); await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running',$4)", [id, take, randomUUID(), JSON.stringify({ coinbaseAccount: selected, selection: { provider }, tools: await mcp.policySnapshot(take) })]); return id; };
    // Coinbase reads start allowed; a member can still block one.
    await mcp.policy(builtin, 'coinbase_portfolios_get', 'blocked');
    const blocked = await run();
    expect((await mcp.call(blocked, 'coinbase_portfolios_get', { accountRef: scope.accountRef })).isError).toBe(true); expect(read).not.toHaveBeenCalled();
    await mcp.policy(builtin, 'coinbase_portfolios_get', 'allowed');
    const id = await run();
    expect((await mcp.call(id, 'coinbase_portfolios_get', { accountRef: other.accountRef })).isError).toBe(true); expect(read).not.toHaveBeenCalled();
    expect((await mcp.call(id, 'coinbase_portfolios_get', { accountRef: scope.accountRef })).isError).not.toBe(true);
    expect(read).toHaveBeenCalledWith(scope, 'coinbase_portfolios_get', {}, expect.any(AbortSignal));
    expect((await mcp.call(id, 'coinbase_orders_create', { accountRef: scope.accountRef })).isError).toBe(true);
    expect((await chat.status(id)).accounts.map(a => a.id)).toEqual([scope.accountRef]);
    expect((await chat.status()).accounts).toEqual([]);
    expect((await db.query('SELECT * FROM tool_invocations WHERE run_id=$1', [id])).rows.length).toBeGreaterThanOrEqual(2);
    await mcp.policy(builtin, 'coinbase_portfolios_get', 'ask');
    const waiting = mcp.call(await run(), 'coinbase_portfolios_get', { accountRef: scope.accountRef });
    let approval;
    for (let i = 0; i < 100 && !approval; i++) { approval = (await mcp.approvals())[0]; if (!approval) await new Promise(r => setTimeout(r, 5)); }
    expect(approval).toBeDefined(); revoked = true; await mcp.decide(approval!.id, true);
    expect((await waiting).isError).toBe(true); expect(read).toHaveBeenCalledTimes(1);
    // A later no-account turn still carries the former account in sharing scope.
    await access.configure(true); const later = await run(null, 'codex');
    const permission = access.ensure(later);
    let request;
    for (let i = 0; i < 100 && !request; i++) { request = (await access.pending())[0]; if (!request) await new Promise(r => setTimeout(r, 5)); }
    expect(request?.provider).toBe('codex');
    await access.decide(request!.id, true); await permission;
    expect((await db.query<{ accounts: string[] }>('SELECT accounts FROM take_platform_context WHERE take_id=$1', [take])).rows[0].accounts).toEqual(['coinbase:' + scope.accountRef]);
  } finally { await mcp.close(); await db.close(); }
});


test('provider reads reject incomplete collections and mismatched markets without turning missing data into zero', () => {
  expect(() => checkCoinbaseReadResult('coinbase_orders_list', {}, {})).toThrow();
  expect(() => checkCoinbaseReadResult('coinbase_orders_list', { orders: [], has_next: false }, {})).not.toThrow();
  expect(() => checkCoinbaseReadResult('coinbase_products_get', { product_id: 'ETH-USD' }, { product_id: 'BTC-USD' })).toThrow();
  expect(() => checkCoinbaseReadResult('coinbase_products_get', { product_id: 'BTC-USD', product_type: 'FUTURE' }, { product_id: 'BTC-USD' })).toThrow();
  expect(() => checkCoinbaseReadResult('coinbase_products_best_bid_ask', { pricebooks: [{ product_id: 'ETH-USD' }] }, { product_ids: ['BTC-USD'] })).toThrow();
  expect(() => checkCoinbaseReadResult('coinbase_products_candles', { candles: [], truncated: true }, { product_id: 'BTC-USD' })).not.toThrow();
});

test('chat discovers captured accounts without a composer choice and requires a specific account for reads',async()=>{
 const db=new PGlite();await migrate(db);const database={use:<T>(fn:(db:PGlite)=>Promise<T>)=>fn(db)};
 const prompts:string[]=[];
 const service=createTakes(database,async i=>{prompts.push(i.instructions);i.text('Which account?');},async()=>({ok:true,source:'runtime',models:[{value:'synthetic',label:'Synthetic'}]}),async()=>[{name:'coinbase_portfolios_get'}],undefined,undefined,async()=>[scope,other]);
 const read=vi.fn(async()=>({data:{}}));let revoked=false;
 const chat=createCoinbaseChat(database,{assertChatScope:async s=>{if(revoked&&s.accountRef===other.accountRef)throw Error('Revoked');},readChat:read});
 try{
  await service.start();const takeId=await service.create();await service.send({requestId:randomUUID(),takeId,parentId:null,text:'What is my balance?',selection});await settle(service);
  const row=(await db.query<{id:string;configuration:any}>('SELECT id,configuration FROM take_runs')).rows[0];
  expect(row.configuration.coinbaseAccounts).toEqual([scope,other]);expect(row.configuration.tools).toHaveLength(1);
  expect(prompts[0]).toContain('ask the member');expect(prompts[0]).not.toContain('composer');
  expect((await service.load(takeId)).messages.every(m=>!m.coinbaseAccount)).toBe(true);
  const result=await callOpentakeTool({status:()=>chat.status(row.id),read:(_p,n,a,r)=>chat.read(row.id,n,a,r)},'opentake_list_accounts',{platform:'coinbase'});
  expect(JSON.parse((result.content[0] as {text:string}).text).accounts.map((a:any)=>a.accountRef)).toEqual([scope.accountRef,other.accountRef]);
  await expect(chat.read(row.id,'coinbase_portfolios_get',{})).rejects.toThrow();
  await expect(chat.read(row.id,'coinbase_portfolios_get',{},randomUUID())).rejects.toThrow();
  await chat.read(row.id,'coinbase_portfolios_get',{},other.accountRef);expect(read).toHaveBeenCalledWith(other,'coinbase_portfolios_get',{},undefined);
  revoked=true;await expect(chat.read(row.id,'coinbase_portfolios_get',{},other.accountRef)).rejects.toThrow('Revoked');expect(read).toHaveBeenCalledTimes(1);
 }finally{await service.close();await db.close();}
});
