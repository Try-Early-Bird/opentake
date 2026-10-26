import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicPrivateWrite } from '../private-files';
import { defaultSearchSettings, searchSettingsSchema, type SearchSettings } from '../../shared/search-settings';

// Profile preferences, separate from Take settings and database migration lineage.
export function createSearchSettings(profile: string) {
  const path = join(profile, 'search-settings.json');
  let writes: Promise<unknown> = Promise.resolve();
  return {
    async read(): Promise<SearchSettings> {
      await writes.catch(() => {});
      try { return searchSettingsSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return defaultSearchSettings();
        throw new Error('Search settings could not be loaded. Save your preferences again to repair them.');
      }
    },
    save(input: unknown): Promise<SearchSettings> {
      const value = searchSettingsSchema.parse(input);
      const write = writes.catch(() => {}).then(async () => {
        await atomicPrivateWrite(path, Buffer.from(JSON.stringify(value)));
        return value;
      });
      writes = write;
      return write;
    },
  };
}
