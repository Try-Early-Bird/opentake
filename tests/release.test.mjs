import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { assemble, validateVersion, releaseTargets, releaseDescription } from '../scripts/release.mjs';

const lock = version => ({ version, packages: { '': { version } } });
test('release versions must match tags and both lockfile versions', () => {
  assert.equal(validateVersion({ version: '1.2.0-beta.1' }, lock('1.2.0-beta.1'), 'v1.2.0-beta.1').channel, 'beta');
  assert.equal(validateVersion({ version: '1.2.0' }, lock('1.2.0'), 'v1.2.0').channel, 'latest');
  for (const [version, tag, file] of [['1.2.0','main',lock('1.2.0')], ['1.2.0','v1.2.0',lock('1.1.0')], ['1.2.0-preview.1','v1.2.0-preview.1',lock('1.2.0-preview.1')]]) {
    assert.throws(() => validateVersion({ version }, file, tag));
  }
});
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'release-fixture-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'input');
  for (const [target, os, arch] of [['mac-arm64','mac','arm64'], ['mac-x64','mac','x64'], ['win-x64','win','x64']]) {
    const folder = path.join(input, target);
    await mkdir(folder, { recursive: true });
    const files = [];
    for (const ext of os === 'mac' ? ['zip','dmg'] : ['exe']) {
      const url = `Opentake-1.2.0-${os}-${arch}.${ext}`;
      const content = Buffer.from(url);
      await writeFile(path.join(folder, url), content);
      await writeFile(path.join(folder, `${url}.blockmap`), 'synthetic blockmap');
      files.push({ url, sha512: createHash('sha512').update(content).digest('base64'), size: content.length });
    }
    await writeFile(path.join(folder, `latest${os === 'mac' ? '-mac' : ''}.yml`), YAML.stringify({ version: '1.2.0', files, path: files[0].url, sha512: files[0].sha512 }));
  }
  return { input, output: path.join(dir, 'output') };
}
test('assembles both Mac architectures and Windows with checksums', async t => {
  const { input, output } = await fixture(t);
  await assemble(input, output, '1.2.0', 'latest');
  const metadata = YAML.parse(await readFile(path.join(output, 'latest-mac.yml'), 'utf8'));
  assert.equal(metadata.files.length, 4);
  assert.match(metadata.path, /x64/);
  assert.match(await readFile(path.join(output, 'SHA256SUMS'), 'utf8'), /latest-mac.yml/);
});
test('rejects modified installers before output is created', async t => {
  const { input, output } = await fixture(t);
  await writeFile(path.join(input, 'mac-arm64/Opentake-1.2.0-mac-arm64.zip'), 'corrupt');
  await assert.rejects(assemble(input, output, '1.2.0', 'latest'), /Checksum mismatch/);
});
test('rejects unsafe metadata paths', async t => {
  const { input, output } = await fixture(t);
  const name = path.join(input, 'mac-arm64/latest-mac.yml');
  const metadata = YAML.parse(await readFile(name, 'utf8'));
  metadata.files[0].url = '../../private';
  await writeFile(name, YAML.stringify(metadata));
  await assert.rejects(assemble(input, output, '1.2.0', 'latest'), /Unexpected/);
});
test('rejects missing Windows differential metadata', async t => {
  const { input, output } = await fixture(t);
  await rm(path.join(input, 'win-x64/Opentake-1.2.0-win-x64.exe.blockmap'));
  await assert.rejects(assemble(input, output, '1.2.0', 'latest'), /Missing Windows blockmap/);
});

test('macOS selection excludes Windows signing and describes only Mac installers', () => {
  assert.deepEqual(releaseTargets('macos').map(t => t.target), ['mac-arm64', 'mac-x64']);
  assert.equal(releaseTargets('all').length, 3);
  assert.match(releaseDescription('macos'), /Windows installers are not included/);
  assert.throws(() => releaseTargets('unknown'), /Release platforms/);
});
test('macOS release assembles without Windows artifacts', async t => {
  const { input, output } = await fixture(t);
  await rm(path.join(input, 'win-x64'), { recursive: true });
  await assemble(input, output, '1.2.0', 'latest', 'macos');
  const files = await readdir(output);
  assert.ok(files.includes('latest-mac.yml'));
  assert.ok(!files.includes('latest.yml'));
  assert.ok(!files.some(name => name.endsWith('.exe')));
  const meta = YAML.parse(await readFile(path.join(output, 'latest-mac.yml'), 'utf8'));
  assert.equal(meta.files.length, 4);
});
test('macOS selection still requires both Mac architectures', async t => {
  const { input, output } = await fixture(t);
  await rm(path.join(input, 'mac-x64'), { recursive: true });
  await assert.rejects(assemble(input, output, '1.2.0', 'latest', 'macos'), /ENOENT/);
});

test('signed release builds flip the hardening fuses and keep library validation', () => {
  const release = createRequire(import.meta.url)('../electron-builder.release.cjs');
  assert.deepEqual(release.electronFuses, { runAsNode: true, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true });
  assert.equal(release.extraMetadata.releaseUpdates, true);
  assert.equal(release.mac.entitlements, 'build/entitlements.mac.plist');
  const plist = readFileSync(new URL('../build/entitlements.mac.plist', import.meta.url), 'utf8');
  assert.doesNotMatch(plist, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>/);
});
