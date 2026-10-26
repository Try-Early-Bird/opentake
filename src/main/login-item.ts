import type { App } from 'electron';
import type { LoginItemState } from '../shared/settings';

type LoginApp = Pick<App, 'isPackaged' | 'getLoginItemSettings' | 'setLoginItemSettings'>;

export function createLoginItem(app: LoginApp, platform: string, executable: string) {
  const options = platform === 'win32' ? { path: executable, args: ['--earlybird-login'] } : {};
  function get(): LoginItemState {
    if (!app.isPackaged) return { supported: false, enabled: false, message: 'Available in the installed app, not development mode.' };
    if (platform !== 'darwin' && platform !== 'win32') return { supported: false, enabled: false, message: 'Launch at login is currently available on macOS and Windows.' };
    const state = app.getLoginItemSettings(options);
    const blocked = platform === 'win32' && state.executableWillLaunchAtLogin === false && state.openAtLogin;
    return { supported: true, enabled: state.openAtLogin && !blocked,
      message: state.status === 'requires-approval' ? 'Approve Opentake in System Settings → General → Login Items.'
        : blocked ? 'Opentake startup is disabled in Windows startup settings.' : undefined };
  }
  return { get, set(enabled: unknown): LoginItemState {
    if (typeof enabled !== 'boolean') throw new Error('Invalid login setting');
    if (!get().supported) throw new Error('Launch at login unavailable');
    app.setLoginItemSettings({ ...options, openAtLogin: enabled, ...(platform === 'win32' ? { enabled } : {}) });
    return get();
  } };
}

export function isLoginLaunch(app: LoginApp, platform: string, explicit: boolean): boolean {
  return explicit || (app.isPackaged && platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
}
