/**
 * Contract-workmen overhead is unused regular-shift capacity. On a holiday,
 * an OT-only booking represents the entire attendance and must not create an
 * artificial regular-shift overhead balance.
 */
export function contractOverheadHours(
  maxDailyHours: number,
  regularHours: number,
  overtimeHours: number
): number {
  if (regularHours === 0 && overtimeHours > 0) return 0;
  return Math.max(0, maxDailyHours - regularHours);
}
