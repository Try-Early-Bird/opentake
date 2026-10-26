import { expect, test, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ access: vi.fn(), execFile: vi.fn(), rm: vi.fn() }));
vi.mock('node:fs/promises', () => ({ access: mocks.access, mkdtemp: async () => '/synthetic/isolated', rm: mocks.rm }));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
import { detectOpenCode } from '../../src/main/opencode-runtime';
beforeEach(() => { vi.clearAllMocks(); });
test('missing executable is not installed and is never launched', async () => {
  mocks.access.mockRejectedValue(new Error('missing'));
  expect(await detectOpenCode()).toEqual({ installed: false });
  expect(mocks.execFile).not.toHaveBeenCalled();
});
test('version check uses an isolated home and does not inherit credentials', async () => {
  mocks.access.mockResolvedValue(undefined);
  mocks.execFile.mockImplementation((_file, args, options, callback) => {
    expect(args).toEqual(['--version']);
    expect(options.env.HOME).toBe('/synthetic/isolated');
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(options.timeout).toBe(2500);
    callback(null, '1.18.4\n');
  });
  expect(await detectOpenCode()).toEqual({ installed: true, version: '1.18.4' });
  expect(mocks.rm).toHaveBeenCalledWith('/synthetic/isolated', { recursive: true, force: true });
});
test('failed or unrecognized version does not enable the option', async () => {
  mocks.access.mockResolvedValue(undefined);
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, 'not a version'));
  expect(await detectOpenCode()).toEqual({ installed: false });
});
