// Release builds: notarize the signed app, then staple its ticket with patient retries.
// electron-builder's built-in step retries stapling only briefly, and the Intel runner
// repeatedly lost its connection to Apple's ticket server (stapler error 68).
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { notarizeAndWaitForNotaryTool } = require('@electron/notarize/lib/notarytool');
const { stapleApp } = require('@electron/notarize/lib/staple');

const STAPLE_ATTEMPTS = 10, STAPLE_WAIT_MS = 30_000;

function credentials() {
  const { APPLE_API_KEY: appleApiKey, APPLE_API_KEY_ID: appleApiKeyId, APPLE_API_ISSUER: appleApiIssuer } = process.env;
  if (appleApiKey && appleApiKeyId && appleApiIssuer) return { appleApiKey, appleApiKeyId, appleApiIssuer };
  const { APPLE_ID: appleId, APPLE_APP_SPECIFIC_PASSWORD: appleIdPassword, APPLE_TEAM_ID: teamId } = process.env;
  if (appleId && appleIdPassword && teamId) return { appleId, appleIdPassword, teamId };
  throw new Error('Release builds require Apple notarization credentials in the build environment.');
}

module.exports = async function notarize(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • notarizing ${appPath}`);
  await notarizeAndWaitForNotaryTool({ appPath, ...credentials() });
  for (let attempt = 1; ; attempt++) {
    try { await stapleApp({ appPath }); console.log(`  • stapled notarization ticket (attempt ${attempt})`); return; }
    catch (error) {
      if (attempt >= STAPLE_ATTEMPTS) throw error;
      console.log(`  • stapling failed (attempt ${attempt} of ${STAPLE_ATTEMPTS}); retrying in ${STAPLE_WAIT_MS / 1000}s`);
      await delay(STAPLE_WAIT_MS);
    }
  }
};
