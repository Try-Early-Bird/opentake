import { overviewDetail } from '../../src/main/strategies/overview';
import { expect, test } from 'vitest';
import { createFixture, fixtureId, SMOKE_SIZE } from './fixture';
import { createServices } from './services';

test('overview matches individual reads and shares account reads only within a request', async () => {
  const f = await createFixture({ ...SMOKE_SIZE, accountsPerVenue: 2, allocationsPerAccount: 3 });
  const s = createServices(f);
  try {
    const old = await f.measurement.scope('old', s.takeDetails);
    const oldQueries = f.measurement.samples.filter(s => s.operation.endsWith('query')).length;
    f.measurement.samples.length = 0;
    const overview = await f.measurement.scope('overview', () => s.takeOverview());
    expect(overview).toEqual(old.map(r => ({ ...r, detail: overviewDetail(r.detail) })));
    expect(f.measurement.samples.filter(s => s.operation.endsWith('query')).length).toBeLessThan(oldQueries / 2);
    const cb = f.allocations.find(a => a.venue === 'coinbase')!;
    await f.db.query('UPDATE coinbase_allocations SET max_daily_notional=123.456789,risk_currency=\'USD\' WHERE id=$1', [cb.id]);
    expect((await s.takeOverview()).find(r => r.row.targetTakeId === cb.takeId)?.funding?.risk?.policy.maxDailyNotional).toBe('123.456789');
    await f.db.query("UPDATE coinbase_allocations SET status='reconciliation_required' WHERE id=$1", [cb.id]);
    expect(await s.takeOverview()).toEqual((await s.takeDetails()).map(r => ({ ...r, detail: overviewDetail(r.detail) })));
    expect((await s.takeOverview()).find(r => r.row.targetTakeId === cb.takeId)?.funding?.pnl).toBeNull();
    f.advance(900_001);
    const stale = await s.takeOverview();
    expect(stale).toEqual((await s.takeDetails()).map(r => ({ ...r, detail: overviewDetail(r.detail) })));
    expect(stale.filter(r => r.funding).every(r => r.funding?.valuation?.value === null)).toBe(true);
    expect(s.unexpectedCalls).toEqual([]);
    expect(f.measurement.failures).toEqual([]);
  } finally { await s.stop(); await f.close(); }
});

test('overview preserves archive selection and unavailable detail/route behavior', async () => {
  const f = await createFixture(SMOKE_SIZE), s = createServices(f);
  try {
    const first = f.allocations[0];
    await f.db.query('UPDATE takes SET archived_at=$2 WHERE id=$1', [first.takeId, new Date(f.clock()).toISOString()]);
    expect((await s.takeOverview()).some(r => r.row.targetTakeId === first.takeId)).toBe(false);
    const archived = await s.takeOverview(true);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toEqual({ row: (await s.strategies.list(true))[0], detail: overviewDetail(await s.strategies.read(first.takeId)), funding: null });
    const missing = fixtureId('missing', 'take');
    expect(await s.strategies.readMany([missing])).toEqual({ [missing]: null });
    expect(await s.capital.viewMany([missing], true)).toEqual({ [missing]: null });
    expect(await s.strategies.readMany([])).toEqual({});
    expect(await s.capital.viewMany([])).toEqual({});
    await f.db.query('UPDATE strategies SET current_version_id=NULL,status=\'draft\' WHERE id=$1', [first.strategyId]);
    expect((await s.takeOverview(true))[0].detail).toEqual(overviewDetail(await s.strategies.read(first.takeId)));
  } finally { await s.stop(); await f.close(); }
});

test('batched details preserve the per-Take history limit and draft versus published versions', async () => {
  const f = await createFixture(SMOKE_SIZE), s = createServices(f);
  try {
    const a = f.allocations[0];
    await f.db.query(`INSERT INTO strategy_proposals(id,strategy_id,owner_id,target_take_id,source_take_id,revision,producer,producer_identity,payload,platform_context,verification,operation_id,request_hash,created_at)
      SELECT gen_random_uuid(),p.strategy_id,p.owner_id,p.target_take_id,p.source_take_id,n,'human','{}',p.payload,'{}','{}',gen_random_uuid(),'synthetic',p.created_at+n*interval '1 minute'
      FROM strategy_proposals p CROSS JOIN generate_series(2,205) n WHERE p.strategy_id=$1 AND p.revision=1`, [a.strategyId]);
    await f.db.query(`INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,source_proposal_id,verification,provenance,created_at)
      SELECT gen_random_uuid(),p.strategy_id,p.owner_id,p.revision,1,p.payload->'metadata',p.payload->'spec',p.id,'{}','{}',p.created_at
      FROM strategy_proposals p WHERE p.strategy_id=$1 AND p.revision BETWEEN 2 AND 204`, [a.strategyId]);
    await f.db.query(`UPDATE strategies SET draft_revision_id=(SELECT id FROM strategy_proposals WHERE strategy_id=$1 AND revision=205),
      current_version_id=(SELECT id FROM strategy_versions WHERE strategy_id=$1 AND sequence=204) WHERE id=$1`, [a.strategyId]);
    const old = await s.strategies.read(a.takeId);
    const batch = await s.strategies.readMany(f.allocations.map(a => a.takeId));
    expect(batch[a.takeId]).toEqual(old);
    expect(batch[a.takeId]).toMatchObject({ clean: false, historyTruncated: true });
    expect(batch[a.takeId]?.versions).toHaveLength(200);
    expect(batch[a.takeId]?.proposals).toHaveLength(200);
    for (const other of f.allocations.slice(1)) expect(batch[other.takeId]).toEqual(await s.strategies.read(other.takeId));
  } finally { await s.stop(); await f.close(); }
});
