import { test, expect, vi } from 'vitest';
import { executeAgentRun } from '../../src/main/agent-run';
import type { RunBudget } from '../../src/main/run-budget';
const input = () => ({ id: 'fixture', context: { feature: 'chat' as const, operation: 'respond' as const, sourceRef: 'take-fixture' },
  selection: { provider: 'claude' as const, model: 'fixture' }, adapter: 'fixture', configuration: {}, signal: new AbortController().signal });
const deps = () => ({ audit: { start: vi.fn(async () => ({ traceId: 'trace', runId: 'fixture' })), record: vi.fn(async () => {}), finish: vi.fn(async () => {}) },
  budgets: new Map<string, RunBudget>(), authorize: vi.fn(async () => {}), execute: vi.fn(async (_runtime: Parameters<Parameters<typeof executeAgentRun>[1]['execute']>[0]) => {}), cleanup: vi.fn(async () => {}) });
test('chat lifecycle authorizes before execution and always releases resources', async () => {
  const d = deps(); const order: string[] = [];
  d.authorize.mockImplementation(async () => { order.push('authorize'); expect(d.budgets.has('fixture')).toBe(true); });
  d.execute.mockImplementation(async () => { order.push('execute'); });
  await executeAgentRun(input(), d);
  expect(order).toEqual(['authorize', 'execute']); expect(d.budgets.size).toBe(0);
  expect(d.cleanup).toHaveBeenCalledOnce(); expect(d.audit.finish).toHaveBeenCalledWith('fixture', 'completed');
  d.authorize.mockRejectedValueOnce(new Error('No sharing approval')); d.execute.mockClear();
  await expect(executeAgentRun(input(), d)).rejects.toThrow('No sharing approval');
  expect(d.execute).not.toHaveBeenCalled(); expect(d.budgets.size).toBe(0);
  expect(d.audit.finish).toHaveBeenLastCalledWith('fixture', 'failed');
});
test('shared lifecycle enforces reported usage and finishes audit even if cleanup fails', async () => {
  const d = deps(); const usage = vi.fn();
  d.execute.mockImplementation(async runtime => { await runtime.audit({ kind: 'model.output', payload: { messageId: 'm', usage: { output_tokens: 12 } } }); });
  await expect(executeAgentRun({ ...input(), budgets: { claudeCostUsd: null, outputTokens: 10 }, usage }, d)).rejects.toThrow('output-token');
  expect(usage).toHaveBeenLastCalledWith(expect.objectContaining({ outputTokens: 12, partial: true }));
  expect(d.budgets.size).toBe(0); expect(d.audit.finish).toHaveBeenCalledWith('fixture', 'failed');
  d.execute.mockImplementation(async () => {}); d.cleanup.mockRejectedValueOnce(new Error('cleanup'));
  await expect(executeAgentRun(input(), d)).rejects.toThrow('cleanup');
  expect(d.budgets.size).toBe(0); expect(d.audit.finish).toHaveBeenLastCalledWith('fixture', 'completed');
});
