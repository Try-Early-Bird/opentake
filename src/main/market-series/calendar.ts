export function subtractUtcMonths(ms: number, months: number): number {
  const date = new Date(ms);
  const dayOfMonth = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const daysInTargetMonth = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  date.setUTCDate(Math.min(dayOfMonth, daysInTargetMonth));
  return date.getTime();
}

