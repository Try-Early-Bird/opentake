import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate, migrations } from '../../src/main/migrations';
import { createLocalSearch } from '../../src/main/search/local';

async function fixture(upgrade = false) {
  const db = new PGlite();
  await migrate(db, upgrade ? migrations.filter(m => m.version < 46) : migrations);
  const owner = (await db.query<{ id: string }>('SELECT id FROM local_owners')).rows[0].id;
  const strategy = randomUUID(), version = randomUUID(), take = randomUUID();
  await db.query('INSERT INTO strategies(id,owner_id) VALUES($1,$2)', [strategy, owner]);
  const spec = { target: { weights: [{ instrument: { symbol: 'VTI' } }] } };
  const metadata = { title: 'Broad basket', description: 'Clean energy infrastructure. Income at 100%_literal. Café equipment. abc and bcd.' };
  await db.query("INSERT INTO strategy_versions(id,strategy_id,owner_id,sequence,schema_version,metadata,spec,provenance,verification) VALUES($1,$2,$3,1,1,$4,$5,'{}','{}')", [version, strategy, owner, JSON.stringify(metadata), JSON.stringify(spec)]);
  await db.query("UPDATE strategies SET current_version_id=$2,status='committed' WHERE id=$1", [strategy, version]);
  await db.query("INSERT INTO takes(id,owner_id,title,selection,strategy_id) VALUES($1,$2,'Infrastructure basket','{}',$3)", [take, owner, strategy]);
  const search = createLocalSearch({ use: work => work(db) });
  let revision = 0;
  const draft = async (description: string) => {
    const id = randomUUID();
    await db.query(`INSERT INTO strategy_proposals(id,strategy_id,owner_id,target_take_id,source_take_id,
      revision,producer,producer_identity,payload,platform_context,verification,operation_id,request_hash)
      VALUES($1,$2,$3,$4,$4,$5,'human','{}',$6,'{}','{}',$7,'synthetic')`,
      [id, strategy, owner, take, ++revision, JSON.stringify({ metadata: { title: 'Broad basket', description }, spec }), randomUUID()]);
    await db.query('UPDATE strategies SET draft_revision_id=$2 WHERE id=$1', [strategy, id]);
    return id;
  };
  return { db, search, take, strategy, version, draft };
}

test('description index upgrades existing data without changing old migration checksums or strategy content', async () => {
  const f = await fixture(true);
  try {
    const ledger = (await f.db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
    const before = (await f.db.query('SELECT * FROM strategy_versions')).rows;
    await migrate(f.db);
    expect((await f.db.query('SELECT * FROM app_migrations WHERE version<46 ORDER BY version')).rows).toEqual(ledger);
    expect((await f.db.query('SELECT * FROM strategy_versions')).rows).toEqual(before);
    expect((await f.search('energy', false)).takes.map(t => t.id)).toEqual([f.take]);
    expect((await f.search('ENERGY INFRA', false)).takes.map(t => t.id)).toEqual([f.take]);
    expect((await f.search('100%_', false)).takes.map(t => t.id)).toEqual([f.take]);
    expect((await f.search('Café', false)).takes.map(t => t.id)).toEqual([f.take]);
    expect((await f.search('VT', false)).takes.map(t => t.id)).toEqual([f.take]);
    expect((await f.search('%', false)).takes.map(t => t.id)).toEqual([f.take]);
    // Both trigrams are present, but the actual substring is not.
    expect((await f.search('abcd', false)).takes).toEqual([]);
    await migrate(f.db);
    expect((await f.search('infrastructure', false)).takes).toHaveLength(1);
    await f.db.exec('SET enable_seqscan=off');
    const plan = await f.db.query(`EXPLAIN SELECT id FROM strategy_versions
      WHERE local_search_grams(local_strategy_search_text(metadata,spec)) @> local_search_grams('energy')`);
    expect(JSON.stringify(plan.rows)).toContain('strategy_versions_search_grams');
  } finally { await f.db.close(); }
});

test('search follows active descriptions, clears removed text, and respects archives without reindex jobs', async () => {
  const f = await fixture();
  try {
    const first = await f.draft('Semiconductor equipment and supply chains');
    expect((await f.search('semiconductor', false)).takes.map(t => t.id)).toEqual([f.take]);
    expect((await f.search('energy', false)).takes).toEqual([]);
    await f.draft('Manufacturing automation');
    expect((await f.search('semiconductor', false)).takes).toEqual([]);
    expect((await f.search('automation', false)).takes.map(t => t.id)).toEqual([f.take]);
    await f.draft('');
    expect((await f.search('automation', false)).takes).toEqual([]);
    expect((await f.search('energy', false)).takes).toEqual([]);
    await f.db.query('UPDATE strategies SET draft_revision_id=$2 WHERE id=$1', [f.strategy, first]);
    expect((await f.search('equipment', false)).takes).toHaveLength(1);
    await f.db.query('UPDATE takes SET archived_at=now() WHERE id=$1', [f.take]);
    expect((await f.search('equipment', false)).takes).toEqual([]);
    expect((await f.search('equipment', true)).takes.map(t => t.id)).toEqual([f.take]);
    await f.db.query("UPDATE takes SET archived_at=NULL,title='New title' WHERE id=$1", [f.take]);
    expect((await f.search('New title', false)).takes.map(t => t.id)).toEqual([f.take]);
    expect((await f.search('Infrastructure basket', false)).takes).toEqual([]);
  } finally { await f.db.close(); }
});
