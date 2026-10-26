import type { AppUpdater } from 'electron-updater';
import { gt, valid } from 'semver';
import type { UpdateCheck, UpdateState } from '../shared/app-updates';

type NativeUpdater = Pick<AppUpdater, 'autoDownload' | 'autoInstallOnAppQuit' | 'allowPrerelease' | 'allowDowngrade' | 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on'>;
export function createUpdateManager(deps: {
  version: string;
  native?: NativeUpdater;
  manualCheck: (preview: boolean) => Promise<UpdateCheck>;
  prepareInstall: () => Promise<void>;
  installFailed: () => Promise<void>;
  changed: (state: UpdateState) => void;
  savePreview: (preview: boolean) => Promise<void>;
}) {
  let state: UpdateState = { status: 'idle', native: !!deps.native, preview: deps.version.includes('-') };
  let timer: ReturnType<typeof setInterval> | undefined;
  let initial: ReturnType<typeof setTimeout> | undefined;
  let operation = false;
  const set = (patch: Partial<UpdateState>) => { state = { ...state, ...patch }; deps.changed({ ...state }); };
  const native = deps.native;
  if (native) {
    native.autoDownload = false;
    native.autoInstallOnAppQuit = false;
    native.allowDowngrade = false;
    native.on('error', () => {
      if (state.status === 'installing') {
        operation = false;
        void deps.installFailed().catch(() => {});
        set({ status: 'error', message: 'Installation failed. Restart Opentake before trying again. Your database has not been reset.' });
      }
    });
    native.on('download-progress', progress => {
      if (state.status === 'downloading') set({ percent: Math.max(0, Math.min(100, progress.percent)) });
    });
  }
  async function check(preview: unknown = state.preview): Promise<UpdateState> {
    if (typeof preview !== 'boolean') throw new Error('Invalid update channel');
    // Never replace metadata for a downloaded or in-flight update.
    if (operation || state.status === 'ready' || state.status === 'installing') return { ...state };
    operation = true;
    set({ status: 'checking', preview, version: undefined, percent: undefined, message: undefined });
    try {
      await deps.savePreview(preview);
      if (native) {
        native.allowPrerelease = preview;
        native.allowDowngrade = false;
        const result = await native.checkForUpdates();
        if (!result) throw new Error('Update service unavailable');
        const version = valid(result.updateInfo.version);
        if (!version) throw new Error('Invalid update version');
        set(result.isUpdateAvailable && gt(version, deps.version)
          ? { status: 'available', version } : { status: 'current' });
      } else set(await deps.manualCheck(preview));
    } catch { set({ status: 'error', message: 'Could not check for updates. Please try again later.' }); }
    finally { operation = false; }
    return { ...state };
  }
  return {
    state: () => ({ ...state }), check,
    start(preview: boolean, enabled: boolean) {
      set({ preview });
      if (!enabled || timer) return;
      initial = setTimeout(() => { void check(); }, 30_000);
      timer = setInterval(() => { void check(); }, 6 * 60 * 60 * 1000);
      initial.unref?.(); timer.unref?.();
    },
    stop() { clearTimeout(initial); clearInterval(timer); timer = undefined; },
    async download(): Promise<UpdateState> {
      if (!native || operation || state.status !== 'available') throw new Error('No update is available to download');
      operation = true; set({ status: 'downloading', percent: 0, message: undefined });
      try { await native.downloadUpdate(); set({ status: 'ready', percent: 100 }); }
      catch { set({ status: 'available', percent: undefined, message: 'Download or verification failed. Please try again.' }); }
      finally { operation = false; }
      return { ...state };
    },
    async install(): Promise<UpdateState> {
      if (!native || operation || state.status !== 'ready') throw new Error('Download an update before installing');
      operation = true; set({ status: 'installing', message: undefined });
      try {
        await deps.prepareInstall();
        native.quitAndInstall(false, true);
      } catch {
        await deps.installFailed().catch(() => {});
        set({ status: 'ready', message: 'The update was not installed. Finish active work and retry, or restart the app.' });
        operation = false;
      }
      return { ...state };
    },
  };
}
