import { describe, expect, it, vi } from 'vitest';
import { createAppUpdates } from '../../src/main/app-updates';

function release(tag: string, name = 'Opentake-arm64.dmg', patch = {}) {
  return { tag_name: tag, draft: false, prerelease: false,
    assets: [{ name, state: 'uploaded', size: 100 }], ...patch };
}
function fixture(releases: unknown = [], version = '0.1.0', platform = 'darwin') {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(releases)));
  const openExternal = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  const updates = createAppUpdates({ version, platform, packaged: true, arch: 'arm64', build: 'fixture' }, { fetch: fetcher, openExternal });
  return { updates, fetcher, openExternal };
}

describe('manual app updates', () => {
  it('reads the build version without a network request', () => {
    const { updates, fetcher } = fixture();
    expect(updates.info()).toMatchObject({ version: '0.1.0', build: 'fixture' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('orders semantic versions, ignores drafts, previews and missing installers', async () => {
    const { updates, fetcher, openExternal } = fixture([
      release('v0.2.0'), release('v0.10.0'), release('v0.11.0-beta.1'),
      release('v8.0.0', undefined, { draft: true }), release('v7.0.0', 'sources.zip'),
      release('v6.0.0', undefined, { prerelease: true }), release('not-semver'),
    ]);
    expect(await updates.check(false)).toEqual({ status: 'available', version: '0.10.0' });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/Try-Early-Bird/opentake-releases/releases?per_page=100');
    await updates.openRelease();
    expect(openExternal).toHaveBeenCalledWith('https://github.com/Try-Early-Bird/opentake-releases/releases/tag/v0.10.0');
  });
  it('supports opting into previews and upgrading from preview to stable', async () => {
    const { updates } = fixture([release('v0.2.0-beta.2', undefined, { prerelease: true })]);
    expect(await updates.check(false)).toEqual({ status: 'unpublished' });
    expect(await updates.check(true)).toEqual({ status: 'available', version: '0.2.0-beta.2' });
    expect(await fixture([release('v0.2.0')], '0.2.0-beta.10').updates.check(false)).toEqual({ status: 'available', version: '0.2.0' });
  });
  it.each(['0.2.0', '0.3.0', '0.2.0+build.2'])('does not downgrade or reinstall %s', async version => {
    expect(await fixture([release('v0.2.0')], version).updates.check(false)).toEqual({ status: 'current' });
  });
  it.each([['darwin', 'app.dmg'], ['win32', 'setup.exe'], ['linux', 'app.AppImage']])('requires an uploaded installer for %s', async (platform, asset) => {
    const { updates, fetcher } = fixture([release('v0.2.0', 'source.zip')], '0.1.0', platform);
    expect(await updates.check(false)).toEqual({ status: 'unpublished' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify([release('v0.2.0', asset)])));
    expect(await updates.check(false)).toEqual({ status: 'available', version: '0.2.0' });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify([release('v0.3.0', asset, { assets: [{ name: asset, state: 'starter', size: 0 }] })])));
    expect(await updates.check(false)).toEqual({ status: 'unpublished' });
  });
  it('reports network, rate-limit and invalid response errors without retaining an old download', async () => {
    const { updates, fetcher, openExternal } = fixture([release('v0.2.0')]);
    await expect(updates.openRelease()).rejects.toThrow();
    expect(await updates.check(false)).toMatchObject({ status: 'available' });
    fetcher.mockRejectedValueOnce(new Error('offline'));
    expect(await updates.check(false)).toMatchObject({ status: 'error' });
    await expect(updates.openRelease()).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    expect(await updates.check(false)).toMatchObject({ status: 'error', message: expect.stringContaining('limiting') });
    fetcher.mockResolvedValueOnce(new Response('{}'));
    expect(await updates.check(false)).toMatchObject({ status: 'error' });
    await expect(updates.check('yes')).rejects.toThrow('Invalid update channel');
  });
  it('rejects simultaneous checks and bounds the request with an abort signal', async () => {
    const { updates, fetcher } = fixture();
    let resolve!: (value: Response) => void;
    fetcher.mockReturnValueOnce(new Promise<Response>(done => { resolve = done; }));
    const pending = updates.check(false);
    expect(await updates.check(true)).toMatchObject({ status: 'error' });
    expect(fetcher.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    resolve(new Response('[]'));
    expect(await pending).toEqual({ status: 'unpublished' });
  });
});
