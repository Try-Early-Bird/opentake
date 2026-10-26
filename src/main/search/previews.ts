import { randomUUID } from 'node:crypto';

export class SearchMaintenanceError extends Error {}

/** Short-lived, single-use confirmations bound to the requesting desktop. */
export function createSearchPreviews<T>() {
  const entries = new Map<string, { owner: string; expires: number; value: T }>();
  return {
    issue(owner: string, value: T) {
      for (const [key, entry] of entries) if (entry.expires <= Date.now()) entries.delete(key);
      while (entries.size >= 32) entries.delete(entries.keys().next().value!);
      const token = randomUUID(); entries.set(token, { owner, expires: Date.now() + 120_000, value }); return token;
    },
    take(token: unknown, owner: string) {
      const entry = typeof token === 'string' ? entries.get(token) : undefined;
      if (!entry || entry.owner !== owner || entry.expires <= Date.now()) throw new SearchMaintenanceError('Preview expired. Check again before confirming.');
      entries.delete(token as string); return entry.value;
    },
    clear() { entries.clear(); },
  };
}
