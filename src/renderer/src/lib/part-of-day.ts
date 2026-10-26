/** The member's local part of day: 5:00–11:59 morning, 12:00–17:59 afternoon, otherwise evening (late night included). */
export function partOfDay(hour: number): 'morning' | 'afternoon' | 'evening' {
  return hour >= 5 && hour < 12 ? 'morning' : hour >= 12 && hour < 18 ? 'afternoon' : 'evening';
}
