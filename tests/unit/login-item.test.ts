import { describe, expect, it, vi } from 'vitest';
import { createLoginItem, isLoginLaunch } from '../../src/main/login-item';

function fixture(packaged = true) {
  let enabled = false;
  return { isPackaged: packaged,
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: enabled, wasOpenedAtLogin: false, wasOpenedAsHidden: false, restoreState: false, executableWillLaunchAtLogin: enabled, launchItems: [] })),
    setLoginItemSettings: vi.fn((settings: { openAtLogin?: boolean }) => { enabled = settings.openAtLogin ?? false; }),
  };
}
describe('launch at login', () => {
  it('never registers development or unsupported platforms', () => {
    for (const [packaged, platform] of [[false, 'darwin'], [true, 'linux']] as const) {
      const app = fixture(packaged); const login = createLoginItem(app, platform, '/fixture/app');
      expect(login.get().supported).toBe(false);
      expect(() => login.set(true)).toThrow();
      expect(app.setLoginItemSettings).not.toHaveBeenCalled();
    }
  });
  it('uses matching Windows read/write paths and quiet startup argument', () => {
    const app = fixture(); const login = createLoginItem(app, 'win32', 'C:\\fixture\\app.exe');
    expect(login.set(true).enabled).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ path: 'C:\\fixture\\app.exe', args: ['--earlybird-login'], openAtLogin: true, enabled: true });
    expect(app.getLoginItemSettings).toHaveBeenLastCalledWith({ path: 'C:\\fixture\\app.exe', args: ['--earlybird-login'] });
    expect(login.set(false).enabled).toBe(false);
    expect(() => login.set('true')).toThrow();
  });
  it('uses native macOS registration and surfaces approval requirements', () => {
    const app = fixture(); const login = createLoginItem(app, 'darwin', '/fixture/app');
    expect(login.set(true).enabled).toBe(true);
    expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({ openAtLogin: true });
    app.getLoginItemSettings.mockImplementation(() => ({ openAtLogin: true, wasOpenedAtLogin: true, wasOpenedAsHidden: false, restoreState: false, executableWillLaunchAtLogin: true, launchItems: [], status: 'requires-approval' }));
    expect(login.get().message).toContain('Approve');
    expect(isLoginLaunch(app, 'darwin', false)).toBe(true);
  });
  it('does not confuse normal app startup with login', () => {
    const app = fixture();
    expect(isLoginLaunch(app, 'darwin', false)).toBe(false);
    expect(isLoginLaunch(app, 'win32', true)).toBe(true);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});
