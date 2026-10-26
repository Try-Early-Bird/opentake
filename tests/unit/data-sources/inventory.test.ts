import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../src/main/migrations';
import { createDataSourceInventory } from '../../../src/main/data-sources/inventory';

test('inventory reads only saved metadata, separates accounts, and preserves last success on failure', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const inventory = createDataSourceInventory({ use: work => work(db) });
    expect(await inventory()).toEqual({ sources: [] });
    const connection = async (venue: string, ref: string, status = 'connected') => (await db.query<{id: string}>(
      'INSERT INTO platform_connections(owner_id,venue,status,external_account_ref) SELECT id,$1,$2,$3 FROM local_owners RETURNING id', [venue, status, ref])).rows[0].id;
    const account = async (connectionId: string, ref: string) => (await db.query<{id: string}>(
      'INSERT INTO linked_accounts(connection_id,external_ref,masked_number,selected,agentic_allowed) VALUES($1,$2,$2,false,false) RETURNING id', [connectionId, ref])).rows[0].id;
    const cb = await connection('coinbase', 'synthetic-cb');
    const a = await account(cb, 'Synthetic A'), b = await account(cb, 'Synthetic B');
    const rh = await account(await connection('robinhood', 'synthetic-rh'), 'Synthetic RH');
    await account(await connection('coinbase', 'removed', 'disconnected'), 'Hidden account');
    const at = '2026-10-16T12:00:00.000Z';
    await db.query('INSERT INTO coinbase_portfolio_observations(account_id,observed_at,data) VALUES($1,$2,$3)', [a, at, JSON.stringify({ privateFixtureValue: 'must-not-leak' })]);
    await db.query("INSERT INTO coinbase_portfolio_sync(account_id,state,attempted_at,error_code) VALUES($1,'failed',$2,'private-provider-error')", [a, at]);
    await db.query("INSERT INTO coinbase_activity_sync(account_id,resource,state,attempted_at,completed_at) VALUES($1,'spot_fills','completed',$2,$2)", [a, at]);
    await db.query("INSERT INTO account_sync_runs(id,account_id,resource,state,started_at) VALUES(gen_random_uuid(),$1,'equity_positions','completed',$2)", [rh, at]);
    await db.query("INSERT INTO account_sync_checkpoints(account_id,resource,watermark) VALUES($1,'equity_positions',$2)", [rh, at]);
    const result = await inventory();
    expect(result.sources).toHaveLength(3);
    expect(result.sources.find(s => s.id === a)?.feeds).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'portfolio', state: 'failed', lastUpdatedAt: at }),
      expect.objectContaining({ id: 'spot_fills', state: 'completed', lastUpdatedAt: at }),
    ]));
    expect(result.sources.find(s => s.id === b)?.feeds).toEqual([expect.objectContaining({ id: 'portfolio', state: 'waiting', lastUpdatedAt: null })]);
    expect(result.sources.find(s => s.id === rh)?.feeds).toEqual([expect.objectContaining({ id: 'equity_positions', state: 'completed', lastUpdatedAt: at })]);
    expect(JSON.stringify(result)).not.toMatch(/must-not-leak|private-provider-error|credential|Hidden account/);
    expect(await inventory()).toEqual(result);
    // One malformed stored account config does not fail every account; it shows the defaults sync uses, flagged.
    await db.query('INSERT INTO coinbase_account_source_settings(account_id,revision,config) VALUES($1,1,$2)', [b, JSON.stringify({ reads: 'malformed' })]);
    const tolerant = await inventory();
    expect(tolerant.sources).toHaveLength(3);
    expect(tolerant.sources.find(s => s.id === b)).toMatchObject({ settingsUnreadable: true, feeds: [expect.objectContaining({ id: 'portfolio', state: 'waiting', enabled: true })] });
    expect(tolerant.sources.find(s => s.id === a)).not.toHaveProperty('settingsUnreadable');
  } finally { await db.close(); }
});
