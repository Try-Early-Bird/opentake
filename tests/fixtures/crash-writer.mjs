import { PGlite } from '@electric-sql/pglite';
const db = new PGlite(process.argv[2]);
await db.exec('create table recovery_probe (value text)');
await db.query('insert into recovery_probe values ($1)', ['committed']);
process.send('committed');
process.on('message', async () => {
  await db.exec('begin');
  await db.query('insert into recovery_probe values ($1)', ['uncommitted']);
  process.send('uncommitted');
});
