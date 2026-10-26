// When something runs, as a sentence says it: "at 9:30 AM" today,
// "tomorrow at 9:30 AM", or "Thursday at 9:30 AM". Queued work usually runs
// at the next open, which is often not today, so a bare time would mislead.

function timeOf(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function whenLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (date.toDateString() === now.toDateString()) return `at ${timeOf(date)}`;
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow at ${timeOf(date)}`;
  return `${date.toLocaleDateString(undefined, { weekday: 'long' })} at ${timeOf(date)}`;
}

/** The compact form for a list row: "9:30 AM", "Tomorrow 9:30 AM", or "Thu 9:30 AM". */
export function whenShort(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (date.toDateString() === now.toDateString()) return timeOf(date);
  if (date.toDateString() === tomorrow.toDateString()) return `Tomorrow ${timeOf(date)}`;
  return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${timeOf(date)}`;
}

/** A timeline heading: "Today, 8:30 AM", "Tomorrow, 8:30 AM", or "Thursday, 8:30 AM". */
export function whenHeading(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const day = date.toDateString() === now.toDateString()
    ? 'Today'
    : date.toDateString() === tomorrow.toDateString()
      ? 'Tomorrow'
      : date.toLocaleDateString(undefined, { weekday: 'long' });
  return `${day}, ${timeOf(date)}`;
}
