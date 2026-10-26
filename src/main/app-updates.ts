import { gt, prerelease, rcompare, valid } from 'semver';
import { z } from 'zod';
import type { AppVersion, UpdateCheck } from '../shared/app-updates';

const releasesUrl = 'https://github.com/Try-Early-Bird/opentake-releases/releases';
const apiUrl = 'https://api.github.com/repos/Try-Early-Bird/opentake-releases/releases?per_page=100';
const releasesSchema = z.array(z.object({
  tag_name: z.string(), draft: z.boolean(), prerelease: z.boolean(),
  assets: z.array(z.object({ name: z.string(), state: z.string(), size: z.number() })),
}));

export function createAppUpdates(info: AppVersion, dependencies: {
  fetch: typeof fetch;
  openExternal: (url: string) => Promise<void>;
}) {
  let releaseUrl: string | undefined;
  let checking = false;
  return {
    info: () => ({ ...info }),
    async check(includePrereleases: unknown): Promise<UpdateCheck> {
      if (typeof includePrereleases !== 'boolean') throw new Error('Invalid update channel');
      if (checking) return { status: 'error', message: 'An update check is already running.' };
      checking = true;
      releaseUrl = undefined;
      try {
        const response = await dependencies.fetch(apiUrl, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Opentake' },
          signal: AbortSignal.timeout(10000), redirect: 'error',
        });
        if (!response.ok) return { status: 'error', message: response.status === 403 || response.status === 429
          ? 'GitHub is limiting update checks. Please try again later.'
          : 'Could not load releases from GitHub. Please try again later.' };
        const extension = info.platform === 'darwin' ? /\.dmg$/i : info.platform === 'win32' ? /\.exe$/i : /\.AppImage$/i;
        // Ignore source-only releases and drafts. SemVer ordering avoids offering
        // a downgrade when an older maintenance release is published later.
        const releases = releasesSchema.parse(await response.json()).filter(release =>
          !release.draft && valid(release.tag_name) &&
          (includePrereleases || (!release.prerelease && !prerelease(release.tag_name))) &&
          release.assets.some(asset => asset.state === 'uploaded' && asset.size > 0 && extension.test(asset.name)),
        ).sort((a, b) => rcompare(a.tag_name, b.tag_name));
        const latest = releases[0];
        if (!latest) return { status: 'unpublished' };
        if (!valid(info.version)) throw new Error('Invalid installed version');
        if (!gt(latest.tag_name, info.version)) return { status: 'current' };
        // Construct the destination from our fixed repository, never API-supplied URLs.
        releaseUrl = `${releasesUrl}/tag/${encodeURIComponent(latest.tag_name)}`;
        return { status: 'available', version: valid(latest.tag_name)! };
      } catch {
        return { status: 'error', message: 'Could not check for updates. Check your internet connection and try again.' };
      } finally { checking = false; }
    },
    async openRelease(): Promise<void> {
      if (!releaseUrl) throw new Error('Check for an update before opening its download.');
      await dependencies.openExternal(releaseUrl);
    },
  };
}
