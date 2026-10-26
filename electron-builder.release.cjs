// Signed release builds only. Local/CI unpacked builds retain the base config.
const { build, version } = require('./package.json');
const { identity: _unsignedIdentity, ...mac } = build.mac;
module.exports = {
  ...build,
  // Without the default disable-library-validation entitlement (see build/entitlements.mac.plist).
  // notarize: false hands notarization to scripts/notarize.cjs (afterSign), which retries stapling.
  mac: { ...mac, hardenedRuntime: true, entitlements: 'build/entitlements.mac.plist', entitlementsInherit: 'build/entitlements.mac.plist', notarize: false },
  afterSign: 'scripts/notarize.cjs',
  // Fuses close ways to run code as the signed app. RunAsNode stays on: AI CLIs, the MCP bridge and
  // the Coinbase CLI run under this binary in Node mode. CI's unpacked builds keep the defaults so
  // Playwright can attach (--inspect, --remote-debugging-port).
  electronFuses: {
    runAsNode: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
  },
  artifactName: 'Opentake-${version}-${os}-${arch}.${ext}',
  forceCodeSigning: true,
  extraMetadata: { releaseUpdates: true },
  publish: [{ provider: 'github', owner: 'Try-Early-Bird', repo: 'opentake-releases', releaseType: 'draft', channel: require('semver').prerelease(version)?.[0]?.toString() || 'latest' }],
  nsis: { deleteAppDataOnUninstall: false },
  beforePack(context) {
    if (context.electronPlatformName === 'darwin') {
      const api = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
      const account = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
      if (!api && !account) throw new Error('Release builds require Apple notarization credentials in the build environment.');
    }
    require('./scripts/prepare-ai-runtime.cjs')();
  },
};
