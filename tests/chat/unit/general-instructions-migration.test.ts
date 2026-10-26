import { test, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { migrate, migrations } from '../../../src/main/migrations';
import { generalInstructionsMigration } from '../../../src/main/general-instructions-migration';

const before = migrations.filter(m => m.version < 14);
const through = [...before, generalInstructionsMigration];
type Row = { name: string; text: string; builtin: string | null; follows_default: boolean; published: { text: string; version: number; followsDefault: boolean } };
const profiles = (db: PGlite) => db.query<Row>('SELECT name,text,builtin,follows_default,published FROM ai_instruction_profiles ORDER BY builtin IS NULL, name').then(r => r.rows);

test('a General that follows the app default keeps following it, with empty about-you context', async () => {
  const db = new PGlite();
  try {
    await migrate(db, before);
    await db.query("INSERT INTO ai_instruction_revisions(id,text,mode) VALUES($1,'Old custom','custom'),($2,'','follow_app_default')", [randomUUID(), randomUUID()]);
    await migrate(db, through);
    const [general] = await profiles(db);
    expect(general).toMatchObject({ name: 'General', text: '', builtin: 'general', follows_default: true });
    expect(general.published).toMatchObject({ version: 1, followsDefault: true });
    expect((await db.query<{ about: string }>('SELECT about FROM ai_user_context')).rows).toEqual([{ about: '' }]);
  } finally { await db.close(); }
});

test('a customized General carries its latest text and a clashing user set is renamed', async () => {
  const db = new PGlite();
  try {
    await migrate(db, before);
    await db.query("INSERT INTO ai_instruction_revisions(id,text,mode) VALUES($1,'First','custom'),($2,'Latest custom','custom')", [randomUUID(), randomUUID()]);
    await db.query("INSERT INTO ai_instruction_profiles(id,name,text) VALUES($1,'general','Mine')", [randomUUID()]);
    await migrate(db, through);
    const rows = await profiles(db);
    expect(rows[0]).toMatchObject({ name: 'General', text: 'Latest custom', follows_default: false });
    expect(rows[0].published).toMatchObject({ text: 'Latest custom', version: 1, followsDefault: false });
    expect(rows[1].name).toMatch(/^general \([0-9a-f]{4}\)$/);
    expect((await db.query('SELECT 1 FROM ai_instruction_versions v JOIN ai_instruction_profiles p ON p.id=v.profile_id WHERE p.builtin=$1', ['general'])).rows).toHaveLength(1);
  } finally { await db.close(); }
});

test('a fresh profile gets a following General', async () => {
  const db = new PGlite();
  try {
    await migrate(db, through);
    expect(await profiles(db)).toMatchObject([{ name: 'General', builtin: 'general', follows_default: true }]);
  } finally { await db.close(); }
});
