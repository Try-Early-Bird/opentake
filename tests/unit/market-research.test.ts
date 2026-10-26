import { expect, test, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { dynamicReadArguments, validateDiscoveredRead } from '../../src/main/market-research-policy';
import { listRobinhoodToolSchemas } from '../../src/main/robinhood-tool-schemas';
import { createEarningsCalendarSync, earningsSyncDate } from '../../src/main/market-series/earnings-calendar';
import { earningsCalendarMigration } from '../../src/main/market-series/earnings-calendar-migration';
import type { createDatabaseLifecycle } from '../../src/main/database';
const tool = { name:'get_equity_news', inputSchema:{type:'object',properties:{symbol:{type:'string'}},required:['symbol'],additionalProperties:false},annotations:{readOnlyHint:true} };
test('new declared reads validate live arguments; writes and account identifiers remain blocked',()=>{
 expect(()=>validateDiscoveredRead(tool,dynamicReadArguments(tool.name,{symbol:'AAPL'}))).not.toThrow();
 expect(()=>validateDiscoveredRead(tool,{})).toThrow('schema');
 for(const definition of [undefined,{...tool,annotations:{}},{...tool,annotations:{readOnlyHint:false}}]) expect(()=>validateDiscoveredRead(definition,{symbol:'AAPL'})).toThrow('read-only');
 expect(()=>dynamicReadArguments(tool.name,{account_number:'synthetic'})).toThrow('account mapping');
 expect(()=>validateDiscoveredRead({...tool,inputSchema:{properties:{account_number:{type:'string'}}}},{})).toThrow('account mapping');
});
test('full discovery includes new research tools and preserves read annotations across pages',async()=>{
 const listTools=vi.fn().mockResolvedValueOnce({tools:[],nextCursor:'next'}).mockResolvedValueOnce({tools:[tool]});
 expect(await listRobinhoodToolSchemas({listTools},new AbortController().signal)).toEqual([tool]);
 expect(listTools).toHaveBeenCalledTimes(2);
});
test('daily calendar snapshots coalesce overlapping work, preserve payloads, and retry failures',async()=>{
 const db=new PGlite();
 try{
  await db.exec(earningsCalendarMigration.sql);
  const database={use:async work=>work(db)} as Pick<ReturnType<typeof createDatabaseLifecycle>,'use'>;
  let now=Date.parse('2026-10-15T16:00:00Z');
  const read=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({data:{results:[]}});
  const sync=createEarningsCalendarSync(database,read,()=>now);
  await expect(sync.tick()).rejects.toThrow('offline');
  await Promise.all([sync.tick(),sync.tick()]);
  await sync.tick();
  expect(read).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenLastCalledWith('get_earnings_calendar',{start_date:'2026-10-15',days:31});
  expect((await db.query('SELECT payload FROM earnings_calendar_snapshots')).rows).toEqual([{payload:{results:[]}}]);
  const afterRestart=createEarningsCalendarSync(database,read,()=>now);
  await afterRestart.tick();expect(read).toHaveBeenCalledTimes(2);
  now=Date.parse('2026-10-16T04:00:00Z');await afterRestart.tick();expect(read).toHaveBeenCalledTimes(3);
  expect(earningsSyncDate(Date.parse('2026-12-16T04:59:00Z'))).toBe('2026-12-15');
 }finally{await db.close();}
});
