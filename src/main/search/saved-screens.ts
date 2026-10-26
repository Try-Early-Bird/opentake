import { SearchMaintenanceError } from './previews';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicPrivateWrite, privateDirectory } from '../private-files';
import { SAVED_SEARCH_BACKUP_MAX_BYTES, savedSearchSourceSchema, type SavedSearchSummary } from '../../shared/saved-search';
import { searchSettingsSchema } from '../../shared/search-settings';

export const savedScreenSchema = z.object({
  version: z.literal(1), id: z.uuid(), originRunId: z.uuid(), createdAt: z.iso.datetime(),
  title: z.string().trim().min(1).max(120), question: z.string().trim().min(3).max(2000),
  // Historical attribution only. Replay never requires or calls this model.
  selection: searchSettingsSchema.shape.selection.unwrap(),
  sources: z.array(savedSearchSourceSchema).min(1).max(20), includeNewVenues: z.literal(false),
}).strict().refine(value => new Set(value.sources.map(s => JSON.stringify(s.scope))).size === value.sources.length);
export type SavedScreen = z.infer<typeof savedScreenSchema>;
const fileSchema = z.object({ version: z.literal(1), screens: z.array(savedScreenSchema).max(100) }).strict()
  .refine(value => new Set(value.screens.map(s => s.id)).size === value.screens.length
    && new Set(value.screens.map(s => s.originRunId)).size === value.screens.length);
const backupSchema = z.object({ kind: z.literal('opentake-saved-screens'), version: z.literal(1), exportedAt: z.iso.datetime(), screens: fileSchema.shape.screens }).strict()
  .refine(value => fileSchema.safeParse({ version: 1, screens: value.screens }).success);
function parseBackup(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '') > SAVED_SEARCH_BACKUP_MAX_BYTES) throw new SearchMaintenanceError('Saved-screen backup exceeds 4 MB.');
  const parsed = backupSchema.safeParse(value);
  if (!parsed.success) throw new SearchMaintenanceError('Invalid or unsupported saved-screen backup. Existing screens were not changed.');
  return parsed.data;
}
function additions(existing: SavedScreen[], incoming: SavedScreen[]) {
  return incoming.filter(screen => {
    const matches = existing.filter(s => s.id === screen.id || s.originRunId === screen.originRunId);
    if (!matches.length) return true;
    if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(screen)) throw new SearchMaintenanceError('This backup conflicts with a saved screen. Existing screens were not changed.');
    return false;
  });
}
export function summarizeScreen(screen: SavedScreen): SavedSearchSummary {
  return { id: screen.id, title: screen.title, question: screen.question, createdAt: screen.createdAt,
    venues: [...new Set(screen.sources.map(source => source.scope.venue))],
    conditions: screen.sources.flatMap(source => [
      ...source.definition.filters.map(filter => `${source.scope.venue}: ${filter.filter_type} ${filter.predicate} ${filter.values.join(', ')}${filter.interval ? ` · ${filter.interval}` : ''}${filter.length ? ` · length ${filter.length}` : ''}`),
      `${source.scope.venue}: ${source.definition.sorting_column} ${source.definition.sorting_direction}`,
    ]),
  };
}
/** Host singleton. This profile-local file is not included in database exports.
 * It stores portable definitions separately from remote managed-scan ownership. */
export function createSavedScreens(profile: string) {
  const directory = join(profile, 'search'), path = join(directory, 'saved-screens.json');
  let writes: Promise<unknown> = Promise.resolve();
  async function load() {
    try { return fileSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 as const, screens: [] as SavedScreen[] };
      throw new SearchMaintenanceError('Saved screens could not be loaded. Existing records were not changed.');
    }
  }
  function mutate<T>(change: (screens: SavedScreen[]) => T) {
    const next = writes.catch(() => {}).then(async () => {
      const data = await load(); const result = change(data.screens); fileSchema.parse(data);
      parseBackup({ kind: 'opentake-saved-screens', version: 1, exportedAt: new Date().toISOString(), screens: data.screens });
      await privateDirectory(directory); await atomicPrivateWrite(path, Buffer.from(JSON.stringify(data)));
      return result;
    });
    writes = next; return next;
  }
  return {
    async exportBackup() {
      await writes.catch(() => {});
      return parseBackup({ kind: 'opentake-saved-screens', version: 1, exportedAt: new Date().toISOString(), screens: (await load()).screens });
    },
    async previewBackup(value: unknown) {
      const backup = parseBackup(value); await writes.catch(() => {});
      const existing = (await load()).screens, added = additions(existing, backup.screens);
      if (existing.length + added.length > 100) throw new SearchMaintenanceError('Import exceeds the 100 saved-screen limit.');
      return { backup, screens: added.map(summarizeScreen), skipped: backup.screens.length - added.length };
    },
    importBackup(value: unknown) {
      const backup = parseBackup(value);
      return mutate(screens => {
        const added = additions(screens, backup.screens);
        if (screens.length + added.length > 100) throw new SearchMaintenanceError('Import exceeds the 100 saved-screen limit.');
        screens.push(...added); return { imported: added.length, skipped: backup.screens.length - added.length };
      });
    },
    async list() { await writes.catch(() => {}); return (await load()).screens.map(summarizeScreen).reverse(); },
    async get(id: unknown) {
      const key = z.uuid().parse(id); await writes.catch(() => {});
      const value = (await load()).screens.find(screen => screen.id === key);
      if (!value) throw new SearchMaintenanceError('Saved screen unavailable.'); return value;
    },
    save(input: Omit<SavedScreen, 'version' | 'id' | 'createdAt' | 'includeNewVenues'>) {
      const screen = savedScreenSchema.parse({ ...input, version: 1, id: randomUUID(), createdAt: new Date().toISOString(), includeNewVenues: false });
      return mutate(screens => {
        const existing = screens.find(s => s.originRunId === screen.originRunId);
        if (existing) { existing.title = screen.title; return summarizeScreen(existing); }
        if (screens.length >= 100) throw new SearchMaintenanceError('Remove a saved screen before adding another (limit 100).');
        screens.push(screen); return summarizeScreen(screen);
      });
    },
    remove(id: unknown) {
      const key = z.uuid().parse(id);
      return mutate(screens => { const index = screens.findIndex(s => s.id === key); if (index >= 0) screens.splice(index, 1); });
    },
  };
}
