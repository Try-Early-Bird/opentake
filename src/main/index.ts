import { databaseWorkerPath } from './database-client';
import { app } from 'electron';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { bootBackgroundHost } from './background-host';
import { bootDesktop } from './desktop';
import { isLoginLaunch } from './login-item';

if (process.platform !== 'win32') process.umask(0o077);
// Signed releases refuse debugging switches: anyone who can launch the app could otherwise drive
// its windows (and their trading IPC) over the DevTools protocol. Fuses already block --inspect.
const refused = app.isPackaged && debuggingRefused(app.commandLine);
function debuggingRefused(commandLine: Pick<typeof app.commandLine, 'hasSwitch'>) {
  if (!['remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'inspect', 'inspect-brk', 'inspect-port'].some(name => commandLine.hasSwitch(name))) return false;
  try { return JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).releaseUpdates === true; } catch { return true; }
}
// Branding is independent of the existing profile and OS encryption identity.
// Keep this stable until an explicit storage/keychain migration is implemented.
// macOS safeStorage keys its keychain item by app name, so development builds
// use the same name; otherwise they silently get a new key and saved credentials stop decrypting.
app.setName('Earlybird OSS');
if (app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'Earlybird OSS'));
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', join(app.getPath('appData'), 'earlybird-oss-development'));
}
const profile = app.getPath('userData');
const build = createHash('sha256').update(readFileSync(__filename)).update(readFileSync(databaseWorkerPath)).digest('hex');
// app.exit does not stop this script before ready, so nothing boots after a refusal.
if (refused) app.exit(1);
else if (app.commandLine.hasSwitch('earlybird-host') || isLoginLaunch(app, process.platform, app.commandLine.hasSwitch('earlybird-login'))) bootBackgroundHost(profile, build);
else {
  // Development only, on the developer's own dev profile (tests pass --user-data-dir):
  // the desktop renderer accepts DevTools Protocol connections on localhost:9224 so
  // live end-to-end runs can drive the UI (owner decision 2026-10-05). The background
  // host never gets it, and packaged builds never do.
  if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) app.commandLine.appendSwitch('remote-debugging-port', '9224');
  bootDesktop(profile, build);
}
