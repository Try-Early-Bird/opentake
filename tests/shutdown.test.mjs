import { readHostLog } from './helpers/diagnostics.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import executablePath from 'electron';
import { temporaryProfile } from './helpers/profile.mjs';
import { stopHost } from './helpers/host.mjs';

const executable = process.env.EARLYBIRD_TEST_APP || executablePath;
const baseArgs = process.env.EARLYBIRD_TEST_APP ? [] : ['.'];
baseArgs.push('--earlybird-test-no-secrets');
if (process.env.CI && process.platform === 'linux') baseArgs.push('--no-sandbox');

async function waitForReady(profile, child) {
  for (let i = 0; i < 400; i++) {
    assert.equal(child.exitCode, null, 'process must not exit before readiness');
    const log = await readHostLog(profile).catch(() => '');
    if (log.includes('"app.ready"')) return;
    await delay(25);
  }
  throw new Error('App did not become ready');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${signal} closes the database, exits, and permits relaunch`, { timeout: 40_000, skip: process.platform === 'win32' }, async () => {
    const profile = await temporaryProfile();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_RENDERER_URL;
    try {
      for (let run = 0; run < 2; run++) {
        const previous = await readHostLog(profile.root).catch(() => '');
        const child = spawn(executable, [...baseArgs, `--user-data-dir=${profile.root}`], { env, stdio: 'ignore' });
        const exited = once(child, 'exit');
        let watchdog;
        try {
          if (run === 0) await waitForReady(profile.root, child);
          else {
            for (let i = 0; i < 400; i++) {
              const current = await readHostLog(profile.root);
              if (current.slice(previous.length).includes('"app.ready"')) break;
              assert.equal(child.exitCode, null, 'new process must acquire the released lock');
              await delay(25);
              if (i === 399) throw new Error('Relaunch did not become ready');
            }
          }
          watchdog = setTimeout(() => child.kill('SIGKILL'), 8000);
          child.kill(signal);
          const [code, exitSignal] = await exited;
          assert.equal(exitSignal, null, 'shutdown must exit without a forced kill');
          assert.equal(code, 0);
          await stopHost(profile.root);
          // The host unpublishes its manifest immediately before its final log write.
          let events = [];
          for (let attempt = 0; attempt < 120; attempt++) {
            events = (await readHostLog(profile.root)).slice(previous.length).trim().split('\n').filter(Boolean).map(line => JSON.parse(line).event);
            if (events.includes('database.closed')) break;
            await delay(25);
          }
          assert.ok(events.includes('database.closed'));
          assert.equal(events.at(-1), 'database.closed');
        } finally {
          clearTimeout(watchdog);
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          await exited;
        }
      }
    } finally {
      await stopHost(profile.root);
      await profile.cleanup();
    }
  });
}
