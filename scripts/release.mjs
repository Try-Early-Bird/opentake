import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, mkdir, copyFile, writeFile, readdir, stat, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import semver from 'semver';
import YAML from 'yaml';

export function validateVersion(pkg, lock, tag) {
  const version = pkg.version;
  if (semver.valid(version) !== version || tag !== `v${version}` ||
      lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('Release tag, package version, and lockfile version must match exactly');
  }
  const pre = semver.prerelease(version);
  if (pre && !['alpha', 'beta', 'rc'].includes(pre[0])) throw new Error('Use alpha, beta, or rc prerelease versions');
  if (semver.parse(version).build.length) throw new Error('Build metadata is not supported for release tags');
  return { version, channel: pre?.[0] || 'latest', prerelease: !!pre };
}
export function releaseTargets(platforms = 'all') {
  if (!['macos', 'all'].includes(platforms)) throw new Error('Release platforms must be macos or all');
  const targets = [
    { target: 'mac-arm64', runner: 'macos-15', platform: 'mac', arch: 'arm64', certificate: 'MAC_CSC_LINK', password: 'MAC_CSC_KEY_PASSWORD' },
    { target: 'mac-x64', runner: 'macos-15-intel', platform: 'mac', arch: 'x64', certificate: 'MAC_CSC_LINK', password: 'MAC_CSC_KEY_PASSWORD' },
  ];
  if (platforms === 'all') targets.push({ target: 'win-x64', runner: 'windows-latest', platform: 'win', arch: 'x64', certificate: 'WIN_CSC_LINK', password: 'WIN_CSC_KEY_PASSWORD' });
  return targets;
}
export function releaseDescription(platforms) {
  releaseTargets(platforms);
  return platforms === 'macos' ? 'Signed macOS installers for Apple Silicon and Intel. Windows installers are not included in this release.' : 'Signed macOS (Apple Silicon and Intel) and Windows x64 installers.';
}
async function hash(file, algorithm, encoding) {
  const digest = createHash(algorithm);
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest(encoding);
}
export async function assemble(input, output, version, channel, platforms = 'all') {
  const assets = new Map();
  const metas = [];
  for (const { target, platform: os, arch } of releaseTargets(platforms)) {
    const dir = path.join(input, target);
    const base = `Opentake-${version}-${os}-${arch}`;
    const extensions = os === 'mac' ? ['dmg', 'zip'] : ['exe'];
    const allowed = extensions.map(ext => `${base}.${ext}`);
    const metaName = `${channel}${os === 'mac' ? '-mac' : ''}.yml`;
    const meta = YAML.parse(await readFile(path.join(dir, metaName), 'utf8'));
    if (meta.version !== version || !Array.isArray(meta.files) || !meta.files.length) throw new Error(`Invalid metadata for ${target}`);
    const seen = new Set();
    for (const file of meta.files) {
      if (!allowed.includes(file.url) || seen.has(file.url)) throw new Error(`Unexpected or duplicate metadata asset for ${target}`);
      seen.add(file.url);
      const source = path.join(dir, file.url);
      if (await hash(source, 'sha512', 'base64') !== file.sha512) throw new Error(`Checksum mismatch: ${file.url}`);
      if (file.size !== (await stat(source)).size) throw new Error(`Size mismatch: ${file.url}`);
    }
    for (const name of allowed) {
      if (!seen.has(name)) throw new Error(`Missing metadata asset: ${name}`);
      assets.set(name, path.join(dir, name));
    }
    // Builder emits external differential blockmaps for NSIS/DMG; ZIP carries its own.
    const names = await readdir(dir);
    for (const name of allowed.map(name => `${name}.blockmap`)) {
      if (names.includes(name)) assets.set(name, path.join(dir, name));
    }
    if (os === 'win' && !assets.has(`${base}.exe.blockmap`)) throw new Error('Missing Windows blockmap');
    if (!seen.has(meta.path) || meta.sha512 !== meta.files.find(f => f.url === meta.path)?.sha512) throw new Error(`Invalid legacy metadata for ${target}`);
    metas.push({ name: metaName, meta });
  }
  // Retain x64 legacy fields; current MacUpdater selects arm64 by filename.
  const mac = { ...metas[1].meta, files: [...metas[1].meta.files, ...metas[0].meta.files] };
  await mkdir(output, { recursive: false });
  for (const [name, source] of assets) await copyFile(source, path.join(output, name));
  await writeFile(path.join(output, metas[0].name), YAML.stringify(mac));
  if (platforms === 'all') await writeFile(path.join(output, metas[2].name), YAML.stringify(metas[2].meta));
  const sums = [];
  for (const name of (await readdir(output)).sort()) sums.push(`${await hash(path.join(output, name), 'sha256', 'hex')}  ${name}`);
  await writeFile(path.join(output, 'SHA256SUMS'), `${sums.join('\n')}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const info = validateVersion(JSON.parse(await readFile('package.json')), JSON.parse(await readFile('package-lock.json')), process.env.RELEASE_TAG);
  const platforms = process.env.RELEASE_PLATFORMS || 'all';
  const targets = releaseTargets(platforms);
  if (process.argv[2] === 'assemble') await assemble('release-input', 'release-output', info.version, info.channel, platforms);
  else if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: targets })}\nplatforms=${platforms}\n`);
  console.log(`Validated ${info.version} (${info.channel})`);
}
