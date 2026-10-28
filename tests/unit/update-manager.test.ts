import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUpdateManager } from '../../src/main/update-manager';

function fixture() {
  const native = Object.assign(new EventEmitter(), {
    autoDownload: true, autoInstallOnAppQuit: true, allowPrerelease: false, allowDowngrade: true,
    checkForUpdates: vi.fn().mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '0.2.0' } }),
    downloadUpdate: vi.fn().mockResolvedValue(['/synthetic/update']), quitAndInstall: vi.fn(),
  });
  const deps = { version: '0.1.0', native: native as unknown as NonNullable<Parameters<typeof createUpdateManager>[0]['native']>,
    manualCheck: vi.fn().mockResolvedValue({ status: 'unpublished' }), prepareInstall: vi.fn().mockResolvedValue(undefined),
    installFailed: vi.fn().mockResolvedValue(undefined), changed: vi.fn(), savePreview: vi.fn().mockResolvedValue(undefined) };
  return { native, deps, manager: createUpdateManager(deps) };
}
afterEach(() => { vi.useRealTimers(); });
describe('update coordinator', () => {
  it('checks on launch and every six hours, but never downloads or installs automatically', async () => {
    vi.useFakeTimers();
    const { manager, native } = fixture();
    manager.start(false, true);
    await vi.advanceTimersByTimeAsync(4_999); expect(native.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(manager.state().status).toBe('available');
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(native.autoDownload).toBe(false); expect(native.autoInstallOnAppQuit).toBe(false); expect(native.allowDowngrade).toBe(false);
    expect(native.downloadUpdate).not.toHaveBeenCalled(); expect(native.quitAndInstall).not.toHaveBeenCalled();
    manager.stop(); await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000); expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
  });
  it('checks again on returning to the app only when the last check is over an hour old and nothing is on offer', async () => {
    vi.useFakeTimers();
    const { manager, native } = fixture();
    native.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '1.0.0' } });
    manager.checkIfStale(); await vi.advanceTimersByTimeAsync(0); expect(native.checkForUpdates).not.toHaveBeenCalled();
    manager.start(false, true); await vi.advanceTimersByTimeAsync(5_000); expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59 * 60 * 1000); manager.checkIfStale(); await vi.advanceTimersByTimeAsync(0);
    expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
    native.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '1.1.0' } });
    await vi.advanceTimersByTimeAsync(60 * 1000); manager.checkIfStale(); await vi.advanceTimersByTimeAsync(0);
    expect(native.checkForUpdates).toHaveBeenCalledTimes(2); expect(manager.state()).toMatchObject({ status: 'available', version: '1.1.0' });
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); manager.checkIfStale(); await vi.advanceTimersByTimeAsync(0);
    expect(native.checkForUpdates).toHaveBeenCalledTimes(2);
    manager.stop();
  });
  it('disables background checks in development and persists channel changes', async () => {
    vi.useFakeTimers(); const { manager, native, deps } = fixture();
    manager.start(false, false); await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000);
    expect(native.checkForUpdates).not.toHaveBeenCalled();
    await manager.check(true); expect(native.allowPrerelease).toBe(true); expect(deps.savePreview).toHaveBeenCalledWith(true);
  });
  it('preserves downloaded metadata, waits for shutdown, and installs only on request', async () => {
    const { manager, native, deps } = fixture();
    await manager.check(false); await manager.download();
    expect(manager.state().status).toBe('ready');
    await manager.check(true); expect(native.checkForUpdates).toHaveBeenCalledTimes(1);
    let finish!: () => void;
    deps.prepareInstall.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const installing = manager.install();
    expect(native.quitAndInstall).not.toHaveBeenCalled();
    await expect(manager.install()).rejects.toThrow();
    finish(); await installing; expect(native.quitAndInstall).toHaveBeenCalledWith(false, true);
  });
  it('refuses installation on a failed shutdown and retains the downloaded update', async () => {
    const { manager, native, deps } = fixture();
    await manager.check(false); await manager.download(); deps.prepareInstall.mockRejectedValue(new Error('busy'));
    expect((await manager.install()).status).toBe('ready'); expect(native.quitAndInstall).not.toHaveBeenCalled();
  });
  it('handles failed downloads and asynchronous installer errors', async () => {
    const { manager, native } = fixture();
    await manager.check(false); native.downloadUpdate.mockRejectedValueOnce(new Error('checksum mismatch'));
    expect((await manager.download()).status).toBe('available');
    await manager.download(); await manager.install(); native.emit('error', new Error('installer failed'));
    expect(manager.state()).toMatchObject({ status: 'error', message: expect.stringContaining('Installation failed') });
  });
  it('rejects downgrades and invalid operations', async () => {
    const { manager, native } = fixture();
    await expect(manager.download()).rejects.toThrow(); await expect(manager.install()).rejects.toThrow();
    native.checkForUpdates.mockResolvedValue({ isUpdateAvailable: true, updateInfo: { version: '0.0.9' } });
    expect((await manager.check(false)).status).toBe('current');
  });
});
