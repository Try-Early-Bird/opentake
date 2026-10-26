import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { validateVersion, releaseDescription } from './release.mjs';

const tag = process.env.RELEASE_TAG;
const info = validateVersion(JSON.parse(await readFile('package.json')), JSON.parse(await readFile('package-lock.json')), tag);
const description = releaseDescription(process.env.RELEASE_PLATFORMS || 'all');
const repo = process.env.GH_REPO;
if (repo !== 'Try-Early-Bird/opentake') throw new Error('Unexpected release repository');
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
const endpoint = `https://api.github.com/repos/${repo}/releases`;
const existing = await fetch(`${endpoint}/tags/${encodeURIComponent(tag)}`, { headers });
if (existing.status !== 404) throw new Error(`Release already exists or lookup failed (${existing.status}). Review it manually; this job never overwrites releases.`);
const created = await fetch(endpoint, {
  method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, name: `Opentake ${info.version}`, draft: true, prerelease: info.prerelease,
    body: description + '\n\nRelease gate: verify install, update from the previous signed version, data retention, native credentials, and update notices on each platform before publishing.\n\nDo not publish a draft with missing assets. SHA256SUMS covers installers, blockmaps, and updater metadata.' }),
});
if (!created.ok) throw new Error(`Draft creation failed (${created.status})`);
const release = await created.json();
const files = (await readdir('release-output')).map(name => `release-output/${name}`);
// No shell interpolation and no --clobber: uploaded/published assets are immutable here.
execFileSync('gh', ['release', 'upload', tag, ...files, '--repo', repo], { stdio: 'inherit' });
console.log(`Draft ready for manual testing: ${release.html_url}`);
