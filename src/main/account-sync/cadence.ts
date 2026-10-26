// No allocations exist in the first slice. Managed cadence arrives with the ledger.
// A conservative weekday session approximation; holidays over-poll rather than
// suppress a read. Trading eligibility never uses this polling clock.
/** Polling while an order Opentake sent is waiting on its fill: fills are only learned from these reads. */
export const FILL_WATCH_MS = 5_000;
export function accountSyncInterval(now: number, engaged: boolean, sending = false, continuous = false): number {
 if (sending) return FILL_WATCH_MS;
 if (continuous) return engaged ? 30_000 : 60_000;
 const fields = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
 const part = (type:string) => fields.find(p=>p.type===type)?.value ?? '';
 const minutes = Number(part('hour'))*60+Number(part('minute'));
 const weekday = !['Sat','Sun'].includes(part('weekday'));
 const regular = weekday && minutes>=570 && minutes<960;
 const extended = weekday && minutes>=240 && minutes<1200;
 return engaged ? regular ? 60_000 : extended ? 300_000 : 600_000 : regular ? 900_000 : extended ? 3_600_000 : 21_600_000;
}
