import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { temporaryProfile } from './helpers/profile.mjs';

test('SIGKILL preserves committed data but not an unfinished transaction', { timeout: 30_000 }, async () => {
  const profile = await temporaryProfile();
  let db;
  const child = fork(new URL('./fixtures/crash-writer.mjs', import.meta.url), [profile.database], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    assert.equal((await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('Writer exited early'); })]))[0], 'committed');
    const message = once(child, 'message');
    child.send('begin');
    assert.equal((await Promise.race([message, exited.then(() => { throw new Error('Writer exited early'); })]))[0], 'uncommitted');
    child.kill('SIGKILL');
    await exited;
    db = new PGlite(profile.database);
    assert.deepEqual((await db.query('select value from recovery_probe')).rows, [{ value: 'committed' }]);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (db) await db.close();
    await profile.cleanup();
  }
});
