import { expect, test } from 'vitest';
import { createFixture } from './fixture';
import { createServices } from './services';

const legacyAccountsSql = 'SELECT DISTINCT ON (account_id) account_id,observed_at,data FROM coinbase_portfolio_observations ORDER BY account_id,observed_at DESC,id DESC';
test('latest-account seeks preserve full snapshots, timestamp ties, stale/empty accounts and chart boundaries', async () => {
  const f = await createFixture({seed:'portfolio-parity',accountsPerVenue:2,allocationsPerAccount:1,historyRows:96});
  const current = createServices(f);
  const legacyDb = new Proxy(f.db,{get(target,key) {
    if(key==='query')return(sql:string,params?:unknown[])=>sql.includes('FROM unnest($1::uuid[]) AS a(account_id)')?target.query(legacyAccountsSql):target.query(sql,params);
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  const legacy = createServices({...f,database:{use:work=>work(legacyDb)}});
  try {
    const accounts=f.accounts.filter(a=>a.venue==='coinbase'),a=accounts[0],b=accounts[1];
    const add=async(id:string,account:string,at:number,value:string)=>f.db.query('INSERT INTO coinbase_portfolio_observations(id,account_id,observed_at,data) VALUES($1,$2,$3,$4)',[id,account,new Date(at).toISOString(),JSON.stringify({portfolio:{totalValue:value,currency:'USD',cash:value,buyingPower:null},spotPositions:[],warnings:[]})]);
    await f.db.query('DELETE FROM coinbase_portfolio_observations WHERE account_id=ANY($1::uuid[])',[accounts.map(a=>a.id)]);
    const cutoff=f.clock()-366*86400000;
    await add('00000000-0000-4000-a000-000000000001',a.id,cutoff-1,'1');
    await add('00000000-0000-4000-a000-000000000002',a.id,cutoff,'2');
    await add('00000000-0000-4000-a000-000000000003',a.id,f.clock()-30000,'3');
    await add('00000000-0000-4000-a000-000000000004',a.id,f.clock(),'4');
    await add('ffffffff-ffff-4fff-afff-ffffffffffff',a.id,f.clock(),'5');
    expect(await current.portfolio.accounts()).toEqual(await legacy.portfolio.accounts());
    const first=await current.portfolio.snapshot(a.id);
    expect(first).toEqual(await legacy.portfolio.snapshot(a.id));
    expect(first.portfolio?.totalValue).toBe('5');
    expect(first.history.map(h=>h.totalValue)).toEqual(['2','3','5']);
    expect((await current.portfolio.accounts()).find(x=>x.id===b.id)?.balance).toBeNull();
    expect(await current.portfolio.snapshot(b.id)).toEqual(await legacy.portfolio.snapshot(b.id));
    // An old observation still supplies a balance even when excluded from chart history.
    await add('00000000-0000-4000-a000-000000000005',b.id,cutoff-1,'9');
    const old=await current.portfolio.snapshot(b.id);
    expect(old).toEqual(await legacy.portfolio.snapshot(b.id));
    expect(old.account?.balance?.totalValue).toBe('9');expect(old.resources[0].stale).toBe(true);expect(old.history).toEqual([]);
    // No persistent cache: a later request sees new evidence.
    f.advance(1000);
    await add('00000000-0000-4000-a000-000000000006',a.id,f.clock(),'6');
    expect((await current.portfolio.snapshot(a.id)).portfolio?.totalValue).toBe('6');
    // The connection list remains authoritative, including order and omitted accounts.
    f.accounts.reverse();
    expect(await current.portfolio.accounts()).toEqual(await legacy.portfolio.accounts());
    f.accounts.splice(f.accounts.findIndex(x=>x.id===a.id),1);
    expect((await current.portfolio.accounts()).map(x=>x.id)).toEqual([b.id]);
    await expect(current.portfolio.snapshot(a.id)).rejects.toThrow();
    f.accounts.splice(0);
    expect(await current.portfolio.accounts()).toEqual([]);
    expect(current.unexpectedCalls).toEqual([]);expect(legacy.unexpectedCalls).toEqual([]);
    expect(f.measurement.failures).toEqual([]);
  } finally {await current.stop();await legacy.stop();await current.portfolio.close();await legacy.portfolio.close();await f.close();}
});
