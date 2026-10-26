import { expect, test } from 'vitest';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createFixture } from './fixture';
import { createServices } from './services';
import { stats } from './latency-runner';

test.skipIf(process.env.EARLYBIRD_PERF_PORTFOLIO !== '1')('measure portfolio reads and capture observation query plans', async () => {
  const output = process.env.EARLYBIRD_PERF_OUTPUT;
  if (!output || !isAbsolute(output) || !process.versions.node.startsWith('24.')) throw Error('Use Node 24 and an absolute output directory');
  const results = [];
  for (const size of [
    {name:'500-takes-10k-history', accountsPerVenue:25, allocationsPerAccount:10, historyRows:10_000},
    {name:'100-takes-100k-history', accountsPerVenue:5, allocationsPerAccount:10, historyRows:100_000},
  ]) for (let repetition = 1; repetition <= 3; repetition++) {
    const f = await createFixture({...size,seed:'baseline-v1'});
    const captured = new Map<string, unknown[]>();
    const db = new Proxy(f.db, {get(target,key) {
      if (key === 'query') return (sql:string, params?:unknown[]) => {captured.set(sql,params??[]);return target.query(sql,params);};
      const value = Reflect.get(target,key); return typeof value === 'function' ? value.bind(target) : value;
    }});
    const s = createServices({...f,database:{use:work=>work(db)}});
    try {
      const account = f.accounts.find(a=>a.venue==='coinbase')!;
      const expected = await s.portfolio.snapshot(account.id);
      expect(expected.portfolio?.totalValue).toBe(account.balance);
      expect(expected.history.length).toBeGreaterThan(0);
      const times:Record<string,number[]> = {accounts:[],snapshot:[]};
      f.measurement.samples.length=0;f.measurement.queries.clear();
      for(let i=0;i<120;i++) for(const name of ['accounts','snapshot']) {
        const start=performance.now();
        const result=await f.measurement.scope<unknown>(name,()=>name==='accounts'?s.portfolio.accounts():s.portfolio.snapshot(account.id));
        times[name].push(performance.now()-start);
        expect(result).toEqual(name==='accounts'?expected.accounts:expected);
      }
      const key=`${size.name}-r${repetition}`;
      await writeFile(join(output,`${key}-raw.json.gz`),gzipSync(JSON.stringify({samples:f.measurement.samples,queries:Object.fromEntries(f.measurement.queries)})));
      const plans=[];
      for(const [sql,params] of captured) {
        if(!sql.includes('coinbase_portfolio_observations')&&!sql.includes('FROM coinbase_capital_reviews r JOIN'))continue;
        plans.push({sql,plan:(await f.db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,params)).rows});
      }
      await writeFile(join(output,`${key}-plans.json`),JSON.stringify(plans,null,2));
      expect(f.measurement.failures).toEqual([]);expect(s.unexpectedCalls).toEqual([]);
      results.push({key,fixture:f.manifest,times,summaries:Object.fromEntries(Object.entries(times).map(([name,values])=>[name,stats(values)]))});
      await writeFile(join(output,'portfolio-run.json'),JSON.stringify({node:process.version,electron:process.versions.electron,results},null,2));
    } finally {await s.stop();await s.portfolio.close();await f.close();}
  }
},600_000);
