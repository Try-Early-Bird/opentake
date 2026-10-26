import { expect, it, vi } from 'vitest';
import { existingHostResponds, processRunning } from '../../src/main/host-liveness';

it('retries a temporarily unresponsive existing host instead of treating it as dead', async () => {
  const ping = vi.fn().mockRejectedValueOnce(new Error('slow')).mockResolvedValue({});
  const wait = vi.fn().mockResolvedValue(undefined);
  expect(await existingHostResponds({ ping, wait, running: () => true })).toBe(true);
  expect(ping).toHaveBeenCalledTimes(2); expect(wait).toHaveBeenCalledTimes(1);
});
it('permits a replacement only after the recorded process has exited', async () => {
  const ping = vi.fn().mockRejectedValue(new Error('offline'));
  expect(await existingHostResponds({ ping, running: () => false })).toBe(false);
  expect(ping).toHaveBeenCalledTimes(1);
});
it('reports a still-running unresponsive host after a bounded retry', async () => {
  const ping = vi.fn().mockRejectedValue(new Error('offline'));
  await expect(existingHostResponds({ ping, running: () => true, wait: async () => {} }, 3)).rejects.toThrow('host_unresponsive');
  expect(ping).toHaveBeenCalledTimes(3);
});
it('rejects unsafe PIDs without signaling a process group', () => {
  expect(() => processRunning(0)).toThrow(); expect(() => processRunning(-1)).toThrow();
  expect(processRunning(process.pid)).toBe(true);
});
