import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { migrate, migrations, migrationHistory, prepareRestoredDatabase } from '../../src/main/migrations';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabaseLifecycle } from '../../src/main/database';

test('migrations run once, keep the owner stable, and reject unknown or changed history', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const owners = (await db.query('SELECT * FROM local_owners')).rows;
    const history = await migrationHistory(db);
    expect(history).toHaveLength(migrations.length);
    await migrate(db);
    expect((await db.query('SELECT * FROM local_owners')).rows).toEqual(owners);
    expect(await migrationHistory(db)).toEqual(history);
    await expect(migrate(db, [])).rejects.toThrow('Unsupported');
    await expect(migrate(db, [{ ...migrations[0], sql: 'select 1' }])).rejects.toThrow('Unsupported');
  } finally { await db.close(); }
});

test('failed migration rolls back its schema and ledger entry; later retry succeeds', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    await expect(migrate(db, [...migrations, { version: migrations.at(-1)!.version + 1, name: 'Failure fixture', sql: 'CREATE TABLE failed_probe(id int); SELECT missing_function();' }])).rejects.toThrow();
    expect((await migrationHistory(db)).map(row => row.version)).toEqual(migrations.map(m => m.version).reverse());
    expect((await db.query("SELECT to_regclass('failed_probe') AS name")).rows).toEqual([{ name: null }]);
    await migrate(db, [...migrations, { version: migrations.at(-1)!.version + 1, name: 'Retry fixture', sql: 'CREATE TABLE failed_probe(id int)' }]);
    expect((await migrationHistory(db)).map(row => row.version)).toEqual([migrations.at(-1)!.version + 1, ...migrations.map(m => m.version).reverse()]);
  } finally { await db.close(); }
});

test('restore preserves identity but clears connection authority even on the same device', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const owners = (await db.query('SELECT id FROM local_owners')).rows;
    await db.exec(`INSERT INTO platform_connections(owner_id, venue, credential_ref, status)
      SELECT id, 'robinhood', 'robinhood:fixture', 'connected' FROM local_owners;
      INSERT INTO linked_accounts(connection_id, external_ref, masked_number, selected)
      SELECT id, 'fixture', '••••1234', true FROM platform_connections;`);
    await prepareRestoredDatabase(db);
    expect((await db.query('SELECT id FROM local_owners')).rows).toEqual(owners);
    expect((await db.query('SELECT credential_ref, status FROM platform_connections')).rows).toEqual([{ credential_ref: null, status: 'reauth_required' }]);
    expect((await db.query('SELECT selected FROM linked_accounts')).rows).toEqual([{ selected: false }]);
  } finally { await db.close(); }
});

test('restore blocks the tools of every imported MCP server and drops their update trust; built-in tools keep theirs', async () => {
  const db = new PGlite();
  try {
    await migrate(db);
    const builtin = '00000000-0000-4000-8000-000000000001', custom = '11111111-1111-4111-8111-111111111111';
    await db.query(`INSERT INTO mcp_servers(id, config, enabled, trust_updates) VALUES($1, '{}', true, false), ($2, '{}', true, true) ON CONFLICT(id) DO UPDATE SET enabled=true`, [builtin, custom]);
    await db.query(`INSERT INTO mcp_tools(server_id, name, definition, fingerprint, policy) VALUES($1, 'opentake_read_rules', '{}', 'f', 'allowed'), ($2, 'shell', '{}', 'f', 'allowed')`, [builtin, custom]);
    await prepareRestoredDatabase(db);
    expect((await db.query('SELECT server_id, policy FROM mcp_tools ORDER BY server_id')).rows).toEqual([{ server_id: builtin, policy: 'allowed' }, { server_id: custom, policy: 'blocked' }]);
    expect((await db.query('SELECT enabled, trust_updates FROM mcp_servers WHERE id=$1', [custom])).rows).toEqual([{ enabled: false, trust_updates: false }]);
  } finally { await db.close(); }
});

// Opens three databases and imports two compressed snapshots, including full
// schema migration on disk. Allow bounded headroom for Windows runner I/O.
test('import rejects newer schemas without replacing the active database and migrates legacy backups', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'earlybird-migration-import-'));
  const lifecycle = createDatabaseLifecycle(join(root, 'database'));
  const future = new PGlite();
  const legacy = new PGlite();
  try {
    const active = await lifecycle.start();
    const originalOwner = (await active.query('SELECT id FROM local_owners')).rows;
    await migrate(future, [...migrations, { version: migrations.at(-1)!.version + 1, name: 'Future fixture', sql: 'CREATE TABLE future_probe(id int)' }]);
    await expect(lifecycle.replace(await future.dumpDataDir('gzip'))).rejects.toThrow('Unsupported');
    expect((await lifecycle.use(db => db.query('SELECT id FROM local_owners'))).rows).toEqual(originalOwner);
    expect(lifecycle.directory).toBe(join(root, 'database'));
    await legacy.exec("CREATE TABLE legacy_probe(value text); INSERT INTO legacy_probe VALUES ('preserved')");
    await lifecycle.replace(await legacy.dumpDataDir('gzip'));
    expect((await lifecycle.use(db => db.query('SELECT * FROM legacy_probe'))).rows).toEqual([{ value: 'preserved' }]);
    expect(await lifecycle.use(migrationHistory)).toHaveLength(migrations.length);
  } finally {
    await lifecycle.close(); await future.close(); await legacy.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup stages the original search v46 upgrade and retains existing Coinbase accounts and the previous database', {timeout:90000}, async()=>{
 const original=(await import('../fixtures/search-position-first-migration.json')).default;
 const root=await mkdtemp(join(tmpdir(),'opentake-search-v46-upgrade-'));
 const path=join(root,'database'),source=new PGlite(path),lifecycle=createDatabaseLifecycle(path);
 try{
  await migrate(source,migrations.filter(m=>m.version<=49).map(m=>m.version===46?original:m));
  await source.exec(`INSERT INTO platform_connections(owner_id,venue,credential_ref,status,external_account_ref)
   SELECT id,'coinbase','synthetic-reference','connected','synthetic-portfolio' FROM local_owners;
   INSERT INTO linked_accounts(connection_id,external_ref,masked_number) SELECT id,'synthetic-portfolio','synthetic' FROM platform_connections;
   INSERT INTO coinbase_connection_details(connection_id,label,portfolio_name,can_trade) SELECT id,'Saved crypto','Saved crypto',true FROM platform_connections;`);
  const before=(await source.query('SELECT * FROM platform_connections')).rows;
  const ledger=(await source.query('SELECT * FROM app_migrations ORDER BY version')).rows;
  await source.close();
  const upgraded=await lifecycle.start();
  expect(lifecycle.directory).not.toBe(path);
  expect((await upgraded.query('SELECT * FROM platform_connections')).rows).toEqual(before);
  expect((await upgraded.query('SELECT * FROM app_migrations WHERE version<=49 ORDER BY version')).rows).toEqual(ledger);
  expect((await migrationHistory(upgraded))[0].version).toBe(migrations.at(-1)!.version);
  await lifecycle.close();
  const previous=new PGlite(path);
  try{expect((await previous.query('SELECT * FROM app_migrations ORDER BY version')).rows).toEqual(ledger);}finally{await previous.close();}
 }finally{if(!source.closed)await source.close();await lifecycle.close();await rm(root,{recursive:true,force:true});}
});
