import { expect, test } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stopHost } from '../helpers/host.mjs';

test('disposable host cleanup waits for process exit after the manifest disappears', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'opentake-host-cleanup-'));
  const script = join(profile, 'host.cjs');
  await writeFile(script, `
    const { createServer } = require('node:http');
    const { writeFileSync, unlinkSync } = require('node:fs');
    const { join } = require('node:path');
    const profile = process.argv[2];
    const manifest = join(profile, 'host.json');
    const server = createServer((request, response) => {
      unlinkSync(manifest);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
      setTimeout(() => {
        writeFileSync(join(profile, 'last-session-write'), 'finished');
        server.close(() => process.exit(0));
      }, 350);
    });
    server.listen(0, '127.0.0.1', () => {
      writeFileSync(manifest, JSON.stringify({ pid: process.pid, port: server.address().port, token: 'synthetic' }));
      process.send('ready');
    });
  `);
  const child = fork(script, [profile], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    await once(child, 'message');
    await stopHost(profile);
    expect(await readFile(join(profile, 'last-session-write'), 'utf8')).toBe('finished');
    expect(await exited).toEqual([0, null]);
    await stopHost(profile); // Repeated cleanup remains harmless.
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});
