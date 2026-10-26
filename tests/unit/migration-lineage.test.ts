import {test,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
import {migrate,migrations} from '../../src/main/migrations';
import {instructionProfilesMigration} from '../../src/main/instruction-profiles-migration';
test('known profiles-first development history upgrades without rewriting its ledger or data',async()=>{
 const db=new PGlite();
 try{
  await migrate(db,[...migrations.filter(m=>m.version<8),{...instructionProfilesMigration,version:8}]);
  const profile=randomUUID(),take=randomUUID();
  await db.query("INSERT INTO ai_instruction_profiles(id,name,text) VALUES($1,'Saved fixture','Keep this text')",[profile]);
  await db.query("INSERT INTO takes(id,owner_id,title,selection,instruction_profile_id) SELECT $1,id,'Saved conversation','{}',$2 FROM local_owners",[take,profile]);
  const before=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
  await migrate(db);
  expect((await db.query('SELECT * FROM app_migrations WHERE version<=8 ORDER BY version')).rows).toEqual(before);
  expect((await db.query('SELECT title,instruction_profile_id FROM takes WHERE id=$1',[take])).rows[0]).toEqual({title:'Saved conversation',instruction_profile_id:profile});
  expect((await db.query<{text:string;published:{text:string}}>('SELECT text,published FROM ai_instruction_profiles WHERE id=$1',[profile])).rows[0]).toMatchObject({text:'Keep this text',published:{text:'Keep this text'}});
  const history=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;await migrate(db);expect((await db.query('SELECT * FROM app_migrations ORDER BY version')).rows).toEqual(history);
  await db.query("UPDATE app_migrations SET checksum='unknown' WHERE version=8");await expect(migrate(db)).rejects.toThrow('Unsupported or modified');
 }finally{await db.close();}
});

for (const profilesFirst of [false, true]) {
 test(`known approval-mode-first v12 upgrades and preserves data (profiles-first=${profilesFirst})`, async () => {
  const db = new PGlite();
  try {
   const legacy = migrations.filter(m => m.version <= 12).map(m => {
    if (profilesFirst && m.version === 8) return {...instructionProfilesMigration, version:8};
    if (profilesFirst && m.version === 9) return {...migrations.find(m => m.version === 8)!, version:9};
    if (m.version === 12) return {...m,sql:m.sql.replace('"authorization" text','"approval_mode" text')};
    return m;
   });
   await migrate(db,legacy);
   const take=randomUUID(),run=randomUUID(),invocation=randomUUID();
   await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Preserved conversation','{}' FROM local_owners",[take]);
   await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'completed','{}')",[run,take,randomUUID()]);
   await db.query("INSERT INTO tool_invocations(id,run_id,take_id,provider,server_name,tool_name,destination,state,approval_mode) VALUES($1,$2,$3,'fixture','fixture','fixture','local','succeeded','approved')",[invocation,run,take]);
   const before=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
   expect((await db.query<{checksum:string}>('SELECT checksum FROM app_migrations WHERE version=12')).rows[0].checksum).toBe('2ff31d86bef0eae691e8f36f9f5647ab278cf2ca2cc38206b178cf1ed8684771');
   await migrate(db);
   expect((await db.query('SELECT * FROM app_migrations WHERE version<=12 ORDER BY version')).rows).toEqual(before);
   expect((await db.query('SELECT approval_mode,state FROM tool_invocations WHERE id=$1',[invocation])).rows).toEqual([{approval_mode:'approved',state:'succeeded'}]);
   expect((await db.query('SELECT title FROM takes WHERE id=$1',[take])).rows).toEqual([{title:'Preserved conversation'}]);
   const after=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
   await migrate(db);
   expect((await db.query('SELECT * FROM app_migrations ORDER BY version')).rows).toEqual(after);
   await db.query("UPDATE app_migrations SET checksum='unknown' WHERE version=12");
   await expect(migrate(db)).rejects.toThrow('Unsupported or modified');
  } finally {await db.close();}
 });
}

for (const coinbaseFirst of [false, true]) {
 test(`search/Coinbase v46 collision upgrades without rewriting data or ledger (Coinbase first=${coinbaseFirst})`, async () => {
  const {coinbaseConnectionMigration}=await import('../../src/main/coinbase/migration');
  const {localSearchIndexMigration}=await import('../../src/main/search/migration');
  const legacy=(await import('../fixtures/coinbase-first-migration.json')).default;
  const {pendingMigrations}=await import('../../src/main/migrations');
  const db=new PGlite();
  try {
   const first=coinbaseFirst?{...coinbaseConnectionMigration,version:46}:localSearchIndexMigration;
   await migrate(db,[...migrations.filter(m=>m.version<46),first]);
   const take=randomUUID();
   await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Preserved Coinbase conversation','{}' FROM local_owners",[take]);
   if(coinbaseFirst){
    expect((await db.query<{checksum:string}>('SELECT checksum FROM app_migrations WHERE version=46')).rows[0].checksum).toBe(legacy.checksum);
    await db.exec(`INSERT INTO platform_connections(owner_id,venue,credential_ref,status,external_account_ref)
      SELECT id,'coinbase','synthetic-reference','connected','11111111-1111-4111-8111-111111111111' FROM local_owners;
      INSERT INTO linked_accounts(connection_id,external_ref,masked_number) SELECT id,external_account_ref,'••••1111' FROM platform_connections;
      INSERT INTO coinbase_connection_details(connection_id,label,portfolio_name,can_trade) SELECT id,'Synthetic','Synthetic',true FROM platform_connections;`);
   }
   const connections=(await db.query('SELECT * FROM platform_connections')).rows;
   const ledger=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
   expect((await pendingMigrations(db)).map(m=>[m.version,m.name])).toEqual([[47,coinbaseFirst?localSearchIndexMigration.name:coinbaseConnectionMigration.name],...migrations.filter(m=>m.version>47).map(m=>[m.version,m.name])]);
   await migrate(db);
   expect((await db.query('SELECT * FROM app_migrations WHERE version<=46 ORDER BY version')).rows).toEqual(ledger);
   expect((await db.query('SELECT * FROM platform_connections')).rows).toEqual(connections);
   expect((await db.query('SELECT title FROM takes WHERE id=$1',[take])).rows).toEqual([{title:'Preserved Coinbase conversation'}]);
   expect((await db.query("SELECT to_regclass('coinbase_connection_details')::text AS coinbase,to_regclass('takes_search_grams')::text AS search")).rows).toEqual([{coinbase:'coinbase_connection_details',search:'takes_search_grams'}]);
   const complete=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
   await migrate(db);expect(await pendingMigrations(db)).toEqual([]);
   expect((await db.query('SELECT * FROM app_migrations ORDER BY version')).rows).toEqual(complete);
   await db.query("UPDATE app_migrations SET checksum='unknown' WHERE version=46");
   await expect(migrate(db)).rejects.toThrow('Unsupported or modified');
  }finally{await db.close();}
 });
}

test('unknown schema history reports the first exact mismatch without modifying the ledger',async()=>{
 const {MigrationHistoryError}=await import('../../src/main/migration-error');
 const {pendingMigrations}=await import('../../src/main/migrations');
 const db=new PGlite();
 try{
  await migrate(db,migrations.filter(m=>m.version<=46));
  await db.query('UPDATE app_migrations SET checksum=$1 WHERE version=46',['a'.repeat(64)]);
  const before=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
  await expect(pendingMigrations(db)).rejects.toMatchObject({mismatch:{version:46,storedChecksum:'a'.repeat(64),latestSupportedVersion:migrations.at(-1)!.version}});
  await expect(migrate(db)).rejects.toBeInstanceOf(MigrationHistoryError);
  expect((await db.query('SELECT * FROM app_migrations ORDER BY version')).rows).toEqual(before);
 }finally{await db.close();}
});


test('original search v46 checksum upgrades forward with preserved ledger, data and working indexes',async()=>{
 const original=(await import('../fixtures/search-position-first-migration.json')).default;
 const {pendingMigrations}=await import('../../src/main/migrations');
 const db=new PGlite();
 try{
  await migrate(db,[...migrations.filter(m=>m.version<46),original]);
  const take=randomUUID();
  await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Saved Coinbase thesis','{}' FROM local_owners",[take]);
  const ledger=(await db.query('SELECT * FROM app_migrations ORDER BY version')).rows;
  expect((await pendingMigrations(db)).map(m=>m.version)).toEqual(migrations.filter(m=>m.version>46).map(m=>m.version));
  await migrate(db);
  expect((await db.query('SELECT * FROM app_migrations WHERE version<=46 ORDER BY version')).rows).toEqual(ledger);
  expect((await db.query("SELECT title FROM takes WHERE local_search_grams(title) @> local_search_grams('Coinbase')")).rows).toEqual([{title:'Saved Coinbase thesis'}]);
  expect((await db.query("SELECT prosrc FROM pg_proc WHERE proname='local_search_grams'")).rows[0]).toMatchObject({prosrc:expect.stringContaining('gram_start')});
  await migrate(db);expect(await pendingMigrations(db)).toEqual([]);
  await db.query("UPDATE app_migrations SET checksum=$1 WHERE version=46",['b'.repeat(64)]);
  await expect(migrate(db)).rejects.toThrow('Unsupported or modified');
 }finally{await db.close();}
});
