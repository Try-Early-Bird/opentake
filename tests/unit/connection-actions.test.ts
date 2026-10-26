import { expect, test, vi } from 'vitest';
import { createConnectionActions } from '../../src/main/connection-actions';
import { captureCallback } from '../../src/main/robinhood-loopback';

test('new sign-in cancels and cleans the previous callback before reusing its port', async () => {
  const actions = createConnectionActions(() => {});
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  let port = 0;
  let cleaned = false;
  const first = actions.run('connect', async signal => {
    const listener = await captureCallback('first-state', signal, 0);
    port = listener.port; ready();
    try { await listener.callback; }
    finally { listener.close(); cleaned = true; }
  });
  const rejected = expect(first).rejects.toThrow('cancelled');
  await started;
  const next = await actions.run('connect', async signal => {
    expect(cleaned).toBe(true);
    const listener = await captureCallback('second-state', signal, port);
    try {
      const stale = await fetch(`http://127.0.0.1:${port}/callback?state=first-state&code=synthetic`);
      expect(stale.status).toBe(400);
      await fetch(`http://127.0.0.1:${port}/callback?state=second-state&code=synthetic-new`);
      return await listener.callback;
    } finally { listener.close(); }
  });
  await rejected;
  expect(next).toBe('synthetic-new');
  expect(actions.busy()).toBe(false);
});

test('rapid retries only start the newest attempt and Back waits for cleanup', async () => {
  const abort = vi.fn();
  const actions = createConnectionActions(abort);
  const skipped = vi.fn(async () => {});
  const first = actions.run('connect', skipped);
  const firstRejected = expect(first).rejects.toThrow('cancelled');
  const second = actions.run('connect', skipped);
  const secondRejected = expect(second).rejects.toThrow('cancelled');
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let cleaned = false;
  const third = actions.run('connect', async signal => {
    started();
    await new Promise<void>(resolve => signal.addEventListener('abort', () => {
      setTimeout(() => { cleaned = true; resolve(); }, 10);
    }, { once: true }));
    signal.throwIfAborted();
  });
  const thirdRejected = expect(third).rejects.toThrow('cancelled');
  await ready;
  await actions.cancel();
  await Promise.all([firstRejected, secondRejected, thirdRejected]);
  expect(cleaned).toBe(true);
  expect(skipped).not.toHaveBeenCalled();
  expect(abort).toHaveBeenCalledTimes(1);
  expect(actions.busy()).toBe(false);
});

test('a sign-in never replaces an unrelated manual operation', async () => {
  const actions = createConnectionActions(() => {});
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const original = actions.run('disconnect', () => waiting);
  await expect(actions.run('connect', async () => {})).rejects.toThrow('busy');
  finish(); await original;
  expect(actions.busy()).toBe(false);
});
