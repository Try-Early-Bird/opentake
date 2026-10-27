// Tags the release commit on main with v<package.json version> and pushes the tag,
// which starts .github/workflows/release.yml (an unpublished draft). Run after the
// version bump has merged: npm run release:tag
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const fail = message => { console.error(`release:tag: ${message}`); process.exit(1); };

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
if (lock.version !== version || lock.packages?.['']?.version !== version) fail(`package-lock.json does not match package.json ${version}`);
if (!/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/.test(version)) fail(`unexpected version ${version}`);
const tag = `v${version}`;

if (git('branch', '--show-current') !== 'main') fail('switch to main first');
if (git('status', '--porcelain')) fail('commit or stash local changes first');
git('fetch', '--quiet', '--tags', 'origin', 'main');
if (git('rev-parse', 'HEAD') !== git('rev-parse', 'origin/main')) fail('local main is not origin/main; pull first');
if (git('tag', '--list', tag)) fail(`${tag} already exists; never move a published tag`);

git('tag', tag);
git('push', 'origin', tag);
console.log(`Pushed ${tag}. The release workflow builds an unpublished draft.`);
