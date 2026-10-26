import { closeDesktop } from './helpers/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { _electron } from 'playwright-core';
import executablePath from 'electron';
import { stopHost } from './helpers/host.mjs';

test('desktop and background host start and reopen with a disposable database', {timeout:45000}, async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-startup-'));
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  let application;
  try {
    let previous;
    for (let launch = 0; launch < 2; launch++) {
      console.log(`Launch ${launch + 1}: starting desktop`);
      application = await _electron.launch({executablePath,args:['.',`--user-data-dir=${profile}`,'--earlybird-test-no-secrets'],env,timeout:15000});
      console.log(`Launch ${launch + 1}: waiting for window`);
      const page = await application.firstWindow({timeout:15000});
      await page.waitForFunction(() => !!window.activity);
      console.log(`Launch ${launch + 1}: querying host`);
      const status = await page.evaluate(() => window.activity.hostStatus());
      assert.ok(status.pid);
      assert.notEqual(status.pid,application.process().pid);
      const history = await page.evaluate(() => window.settings.migrationHistory());
      assert.ok(history.length > 0);
      if (previous) assert.deepEqual(history,previous);
      previous = history;
      console.log(`Launch ${launch + 1}: closing desktop`);
      await closeDesktop(application); application = undefined;
      console.log(`Launch ${launch + 1}: stopping host`);
      await stopHost(profile);
    }
  } finally {
    if (application) await closeDesktop(application);
    await stopHost(profile);
    await rm(profile,{recursive:true,force:true});
  }
});
