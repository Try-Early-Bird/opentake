import { expect, test } from 'vitest';
import { availableChatSelection } from '../../../src/shared/chat-selection';
const connections = [{ provider: 'chatgpt' as const, status: 'connected' as const }];
const catalogs = { chatgpt: { ok: true as const, source: 'runtime' as const, models: [{ value: 'unavailable', label: 'Unavailable', disabled: true }, { value: 'gpt-fixture', label: 'GPT' }] } };
test('connecting ChatGPT replaces the disconnected default with an enabled model', () => {
  expect(availableChatSelection({ provider: 'claude', model: 'default' }, connections, {})).toBeUndefined();
  expect(availableChatSelection({ provider: 'claude', model: 'default' }, connections, catalogs)).toEqual({ provider: 'chatgpt', model: 'gpt-fixture' });
});
test('preserves a valid choice and repairs a stale model without selecting disabled models', () => {
  const current = { provider: 'chatgpt' as const, model: 'gpt-fixture' };
  expect(availableChatSelection(current, connections, catalogs)).toEqual(current);
  expect(availableChatSelection({ ...current, model: 'removed' }, connections, catalogs)).toEqual(current);
  expect(availableChatSelection(current, [], catalogs)).toBeUndefined();
});

test('waits for the selected connected provider during catalog refresh', () => {
  expect(availableChatSelection({ provider: 'claude', model: 'sonnet' },
    [...connections, { provider: 'claude', status: 'connected' }], catalogs)).toBeUndefined();
});


test('effort survives supported model changes and refreshes, resets when unsupported', () => {
  const connections = [{ provider: 'claude' as const, status: 'connected' as const }];
  const current = { provider: 'claude' as const, model: 'first', effort: 'high' as const };
  const catalogs = { claude: { ok: true as const, source: 'runtime' as const, models: [{ value: 'first', label: 'First', effortLevels: ['low' as const, 'high' as const] }] } };
  expect(availableChatSelection(current, connections, {})).toBeUndefined();
  expect(availableChatSelection(current, connections, catalogs)).toEqual(current);
  expect(availableChatSelection({ ...current, model: 'removed' }, connections, catalogs)).toEqual(current);
  expect(availableChatSelection(current, connections, { claude: { ...catalogs.claude, models: [{ value: 'second', label: 'Second' }] } })).toEqual({ provider: 'claude', model: 'second' });
});
