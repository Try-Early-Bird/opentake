const { chmodSync, existsSync, readdirSync } = require('node:fs');
const { dirname, join } = require('node:path');
// node-pty 1.1.0's macOS prebuild ships spawn-helper without executable mode.
// Repair only package helper binaries during install/build, before app signing.
function prepare() {
  if (process.platform === 'win32') return;
  const root = dirname(require.resolve('node-pty/package.json'));
  const prebuilds = join(root, 'prebuilds');
  const candidates = [join(root, 'build/Release/spawn-helper')];
  if (existsSync(prebuilds)) for (const entry of readdirSync(prebuilds)) candidates.push(join(prebuilds, entry, 'spawn-helper'));
  for (const file of candidates) if (existsSync(file)) chmodSync(file, 0o755);
}
module.exports = prepare;
if (require.main === module) prepare();
