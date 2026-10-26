import { SearchMaintenanceError } from './previews';
import { savedSearchSourceSchema } from '../../shared/saved-search';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicPrivateWrite, privateDirectory } from '../private-files';

const text = z.string().trim().min(1).max(256);
const scopeSchema = savedSearchSourceSchema.shape.scope;
export type ManagedScanScope = z.infer<typeof scopeSchema>;
const ownershipSchema = z.object({
  scope: scopeSchema, title: text,
  // A pending record survives failed/ambiguous creation. Never retry it automatically.
  state: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('creating') }).strict(),
    z.object({ kind: z.literal('owned'), id: text }).strict(),
  ]),
}).strict();
type Ownership = z.infer<typeof ownershipSchema>;
const fileSchema = z.object({ version: z.literal(1), records: z.array(ownershipSchema).max(1000) }).strict()
  .refine(value => new Set(value.records.map(record => scopeKey(record.scope))).size === value.records.length);
const scopeKey = (scope: ManagedScanScope) => JSON.stringify([scope.venue, scope.instance, scope.connectionId, scope.accountId]);
const connectionKey = (scope: ManagedScanScope) => JSON.stringify([scope.venue, scope.instance, scope.connectionId]);

/** Host singleton, local to this installation. Ownership is intentionally not portable
 * in database exports: importing a definition must never adopt a remote saved scan. */
export function createManagedScanStore(profile: string) {
  const directory = join(profile, 'search');
  const path = join(directory, 'managed-scans.json');
  let writes: Promise<unknown> = Promise.resolve();
  async function load() {
    try { return fileSchema.parse(JSON.parse(await readFile(path, 'utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 as const, records: [] as Ownership[] };
      throw new SearchMaintenanceError('Managed screener ownership could not be loaded. Existing screeners were not changed.');
    }
  }
  return {
    async read(scope: ManagedScanScope): Promise<Ownership | undefined> {
      scopeSchema.parse(scope);
      await writes.catch(() => {});
      return (await load()).records.find(record => scopeKey(record.scope) === scopeKey(scope));
    },
    save(input: Ownership): Promise<void> {
      const record = ownershipSchema.parse(input);
      const write = writes.catch(() => {}).then(async () => {
        const data = await load();
        const index = data.records.findIndex(item => scopeKey(item.scope) === scopeKey(record.scope));
        if (index < 0) data.records.push(record); else data.records[index] = record;
        fileSchema.parse(data);
        await privateDirectory(directory);
        await atomicPrivateWrite(path, Buffer.from(JSON.stringify(data)));
      });
      writes = write;
      return write;
    },
  };
}

// A saved definition and a live request use the same strict contract.
export const managedScanDefinitionSchema = savedSearchSourceSchema.shape.definition;
export type ManagedScanDefinition = z.infer<typeof managedScanDefinitionSchema>;

/** Normalized host-only adapter. No scan ID or scope is accepted from the model.
 * Each method must settle only when its transport has finished, including aborts;
 * a timeout race that leaves a write running would break connection serialization.
 * inspect must identify provider-managed/read-only scans explicitly, not infer
 * writeability from a missing field. validate must reject unsupported conditions. */
export interface ManagedScanAdapter<Result> {
  recoveryCandidates?(scope: ManagedScanScope, title: string, signal: AbortSignal): Promise<{ id: string; title: string; writable: boolean; providerManaged: boolean }[]>;
  validate(scope: ManagedScanScope, definition: ManagedScanDefinition, signal: AbortSignal): Promise<void>;
  inspect(scope: ManagedScanScope, id: string, signal: AbortSignal, definition: ManagedScanDefinition): Promise<{ id: string; title: string; writable: boolean; providerManaged: boolean } | null>;
  create(scope: ManagedScanScope, title: string, signal: AbortSignal): Promise<{ id: string }>;
  replaceFilters(scope: ManagedScanScope, id: string, filters: ManagedScanDefinition['filters'], signal: AbortSignal): Promise<void>;
  replaceSorting(scope: ManagedScanScope, id: string, sorting: Pick<ManagedScanDefinition, 'sorting_column' | 'sorting_direction'>, signal: AbortSignal): Promise<void>;
  run(scope: ManagedScanScope, id: string, signal: AbortSignal): Promise<Result>;
}

/** One instance per host, shared by all search runs and later saved-screen replay. */
export function createManagedScanExecutor<Result>(deps: {
  store: ReturnType<typeof createManagedScanStore>;
  adapter: ManagedScanAdapter<Result>;
}) {
  const tails = new Map<string, Promise<unknown>>();
  async function locked<T>(scope: ManagedScanScope, operation: () => Promise<T>): Promise<T> {
    const key = connectionKey(scope);
    const work = (tails.get(key) ?? Promise.resolve()).catch(() => {}).then(operation);
    tails.set(key, work);
    try { return await work; } finally { if (tails.get(key) === work) tails.delete(key); }
  }
  return {
    async recover(input: { scope: ManagedScanScope; signal: AbortSignal; authorize(): Promise<void>; confirm?: { id: string; title: string } }) {
      const scope = scopeSchema.parse(input.scope);
      return locked(scope, async () => {
        const gate = async () => { input.signal.throwIfAborted(); await input.authorize(); input.signal.throwIfAborted(); };
        await gate();
        const record = await deps.store.read(scope);
        if (!record || record.state.kind !== 'creating') {
          if (input.confirm) throw new SearchMaintenanceError('Screener ownership changed. Check again.');
          return { status: 'none' as const };
        }
        if (!deps.adapter.recoveryCandidates) throw new SearchMaintenanceError('Recovery unavailable.');
        const candidates = await deps.adapter.recoveryCandidates(scope, record.title, input.signal);
        await gate();
        // Count every title match, including malformed/read-only candidates. Never
        // choose a writable one from an ambiguous set.
        const candidate = candidates.length === 1 ? candidates[0] : undefined;
        if (!candidate || candidate.title !== record.title || !candidate.writable || candidate.providerManaged) {
          if (input.confirm) throw new SearchMaintenanceError('The recovery candidate changed. Check again.');
          return { status: candidates.length ? 'ambiguous' as const : 'missing' as const };
        }
        const id = text.parse(candidate.id);
        if (input.confirm) {
          if (input.confirm.id !== id || input.confirm.title !== record.title) throw new SearchMaintenanceError('The recovery candidate changed. Check again.');
          await gate();
          await deps.store.save({ ...record, state: { kind: 'owned', id } });
        }
        return { status: 'ready' as const, id, title: record.title };
      });
    },
    async run(input: {
      scope: ManagedScanScope; definition: unknown; signal: AbortSignal;
      // Rechecks run permission, sharing, connection and account scope before
      // every upstream operation, including after waiting behind another search.
      authorize(): Promise<void>;
    }): Promise<Result> {
      const scope = scopeSchema.parse(input.scope);
      const definition = managedScanDefinitionSchema.parse(input.definition);
      const key = connectionKey(scope);
      const previous = tails.get(key) ?? Promise.resolve();
      const work = previous.catch(() => {}).then(async () => {
        const gate = async () => { input.signal.throwIfAborted(); await input.authorize(); input.signal.throwIfAborted(); };
        const call = async <T>(operation: () => Promise<T>): Promise<T> => { await gate(); return operation(); };
        await call(() => deps.adapter.validate(scope, definition, input.signal));
        let ownership = await deps.store.read(scope);
        if (ownership?.state.kind === 'creating') throw new SearchMaintenanceError('A previous screener creation has an unresolved outcome. Open Settings → Search to recover it before screening again.');
        if (!ownership) {
          await gate();
          ownership = { scope, title: `Opentake · Ask Agent · ${randomUUID()}`, state: { kind: 'creating' } };
          // Commit intent before dispatch. A lost response or failed ownership save
          // leaves a pending record, so a restart cannot create numbered duplicates.
          await deps.store.save(ownership);
          const created = await call(() => deps.adapter.create(scope, ownership!.title, input.signal));
          const id = text.parse(created.id);
          ownership = { ...ownership, state: { kind: 'owned', id } };
          // Persist a known ID even when cancellation arrived during create.
          await deps.store.save(ownership);
        }
        if (ownership.state.kind !== 'owned') throw new SearchMaintenanceError('Managed screener unavailable.');
        const id = ownership.state.id;
        const remote = await call(() => deps.adapter.inspect(scope, id, input.signal, definition));
        if (!remote || remote.id !== id || remote.title !== ownership.title || remote.writable !== true || remote.providerManaged !== false) {
          throw new SearchMaintenanceError('Managed screener ownership could not be verified. Existing screeners were not changed.');
        }
        // Always replace both parts after an interrupted update. Never reuse a
        // partially configured scan; never recreate it merely because it is missing.
        await call(() => deps.adapter.replaceFilters(scope, id, definition.filters, input.signal));
        await call(() => deps.adapter.replaceSorting(scope, id, {
          sorting_column: definition.sorting_column, sorting_direction: definition.sorting_direction,
        }, input.signal));
        const result = await call(() => deps.adapter.run(scope, id, input.signal));
        await gate(); // A revoked scope must not return its data to the model.
        return result;
      });
      tails.set(key, work);
      try { return await work; }
      finally { if (tails.get(key) === work) tails.delete(key); }
    },
  };
}
