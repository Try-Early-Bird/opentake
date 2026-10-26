import { expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, migrations } from '../../src/main/migrations';
import { createToolGovernance } from '../../src/main/tool-governance';

test('tool history upgrades an existing database and records approval outcomes', async () => {
  const db = new PGlite();
  try {
    await migrate(db, migrations.filter(m => m.version < 12));
    const take = randomUUID(), run = randomUUID();
    await db.query("INSERT INTO takes(id,owner_id,title,selection) SELECT $1,id,'Preserved take','{}' FROM local_owners", [take]);
    await db.query("INSERT INTO take_runs(id,take_id,request_id,state,configuration) VALUES($1,$2,$3,'running','{}')", [run,take,randomUUID()]);
    await migrate(db);
    const governance = createToolGovernance({ use: operation => operation(db) });
    await governance.recover();
    const invocation = await governance.begin(run, 'fixture_tool');
    await invocation.approval(false);
    await invocation.decision('approved');
    await invocation.dispatch();
    await invocation.finish('succeeded', 'Fixture completed.',true);
    const history = await governance.history({takeId:take});
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({take_title:'Preserved take',approval_mode:'approved',state:'succeeded'});
    const expired = await governance.begin(run, 'fixture_tool');
    await expired.approval(false);
    await expired.finish('expired','Fixture expired.',false);
    expect((await governance.history({takeId:take})).items[0]).toMatchObject({approval_mode:'expired',state:'expired'});
  } finally { await db.close(); }
});
