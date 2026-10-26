import { z } from 'zod';
import type { createDatabaseLifecycle } from '../database';

type Database = Pick<ReturnType<typeof createDatabaseLifecycle>, 'use'>;
const payloadSchema = z.object({ results: z.array(z.object({
  symbol: z.string().min(1), report: z.object({ date: z.iso.date() }).passthrough(),
}).passthrough()) }).passthrough();
export function earningsSyncDate(now: number): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now));
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
/** One successful shared 31-day snapshot per New York day, including empty calendars.
 * The single background host owns the database; in-flight work is coalesced.
 */
export function createEarningsCalendarSync(database: Database, read: (name: string, args: Record<string, unknown>) => Promise<unknown>, clock = Date.now) {
  let work: Promise<{ state: 'fresh' | 'synced'; reports?: number }> | undefined;
  let completedDay: string | undefined;
  async function sync() {
    const day = earningsSyncDate(clock());
    if (completedDay === day) return { state: 'fresh' as const };
    const exists = await database.use(db => db.query('SELECT sync_date FROM earnings_calendar_snapshots WHERE sync_date=$1', [day]));
    if (exists.rows.length) { completedDay = day; return { state: 'fresh' as const }; }
    const raw = z.object({ data: z.unknown() }).parse(await read('get_earnings_calendar', { start_date: day, days: 31 }));
    const payload = payloadSchema.parse(raw.data);
    await database.use(db => db.query('INSERT INTO earnings_calendar_snapshots(sync_date,window_days,payload) VALUES($1,31,$2) ON CONFLICT(sync_date) DO NOTHING', [day, JSON.stringify(payload)]));
    completedDay = day;
    return { state: 'synced' as const, reports: payload.results.length };
  }
  return { tick() { return work ??= sync().finally(() => { work = undefined; }); } };
}
