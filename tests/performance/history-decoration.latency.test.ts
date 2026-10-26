import { expect, test } from 'vitest';
import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createFixture } from './fixture';
import { createTakeHistory } from '../../src/main/take-history';
import { legacyDecoration, legacyDecorationSql } from './history-decoration';
import { stats } from './latency-runner';

test.skipIf(process.env.EARLYBIRD_PERF_HISTORY !== '1')('compare history decoration and capture query plans', async () => {
  const output = process.env.EARLYBIRD_PERF_OUTPUT;
  if (!output || !isAbsolute(output) || !process.versions.node.startsWith('24.')) throw Error('Use Node 24 and an absolute output directory');
  const results = [];
  for (const size of [
    {name:'500-takes-10k-history', accountsPerVenue:25, allocationsPerAccount:10, historyRows:10_000},
    {name:'100-takes-100k-history', accountsPerVenue:5, allocationsPerAccount:10, historyRows:100_000},
  ]) for (let repetition = 1; repetition <= 3; repetition++) {
    const f = await createFixture({...size, seed:'baseline-v1'}), history = createTakeHistory(f.database);
    try {
      const take = f.allocations[0], messages = (await history.messages(take.takeId, take.headId)).messages;
      expect(await history.decorate(take.takeId, messages)).toEqual(await legacyDecoration(f.db, take.takeId, messages));
      f.measurement.samples.length = 0; f.measurement.queries.clear();
      const times: Record<string, number[]> = {legacy:[], optimized:[]};
      for (let i = 0; i < 120; i++) for (const name of i % 2 ? ['optimized','legacy'] : ['legacy','optimized']) {
        const start = performance.now();
        await f.measurement.scope(name, () => name === 'legacy' ? legacyDecoration(f.db, take.takeId, messages) : history.decorate(take.takeId, messages));
        times[name].push(performance.now() - start);
      }
      const key = `${size.name}-r${repetition}`;
      await writeFile(join(output, `${key}-raw.json.gz`), gzipSync(JSON.stringify({samples:f.measurement.samples, queries:Object.fromEntries(f.measurement.queries)})));
      const optimizedSql = [...f.measurement.queries.values()].find(q => q.startsWith('WITH ranked'))!;
      expect(optimizedSql).toBeTruthy();
      const plans: Record<string, unknown> = {};
      for (const [name, sql] of [['legacy',legacyDecorationSql],['optimized',optimizedSql]]) {
        plans[name] = (await f.db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [take.takeId,messages.map(m => m.id)])).rows;
      }
      await writeFile(join(output, `${key}-plans.json`), JSON.stringify(plans,null,2));
      expect(f.measurement.failures).toEqual([]);
      results.push({key, fixture:f.manifest, pageSize:messages.length, times, summaries:Object.fromEntries(Object.entries(times).map(([name, values]) => [name,stats(values)]))});
      await writeFile(join(output, 'history-run.json'), JSON.stringify({node:process.version,electron:process.versions.electron,results},null,2));
    } finally { await f.close(); }
  }
}, 600_000);
