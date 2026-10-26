import { afterEach, expect, it, vi } from 'vitest';
import { checkAiConnections } from '../../src/renderer/src/ai-connection-status';

afterEach(() => vi.useRealTimers());

it('explains stale preload and IPC handlers without exposing the underlying error', async () => {
  expect(await checkAiConnections(undefined)).toMatchObject({ ok: false, message: expect.stringContaining('restart') });
  expect(await checkAiConnections({ status: async () => { throw new Error('Unknown operation: ai:status'); } }))
    .toMatchObject({ ok: false, message: expect.stringContaining('restart') });
});

it('preserves connected status and rejects invalid responses', async () => {
  expect(await checkAiConnections({ status: async () => [{ provider: 'claude', status: 'connected' }] }))
    .toEqual({ ok: true, states: [{ provider: 'claude', status: 'connected' }] });
  expect(await checkAiConnections({ status: async () => [] })).toMatchObject({ ok: false });
});

it('bounds a stalled status request so account Continue can recover', async () => {
  vi.useFakeTimers();
  const result = checkAiConnections({ status: () => new Promise(() => {}) });
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toMatchObject({ ok: false, message: expect.stringContaining('unavailable') });
  expect(vi.getTimerCount()).toBe(0);
});
