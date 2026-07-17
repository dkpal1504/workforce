/** Fixed timesheet grid: slot 0 = 08:00 … slot 12 = 20:00 (8a–8p). */
const GRID_START_HOUR = 8;
const GRID_END_HOUR = 20; // last label hour (slot 12)
const GRID_SLOT_COUNT = 13;

export type ShiftConfig = {
  name: string;
  start: string;
  end: string;
  hourSlots: number[];
};

/** Daily hour cap — override via MAX_DAILY_HOURS in .env */
export function getMaxDailyHours(): number {
  const raw = process.env.MAX_DAILY_HOURS;
  const n = raw != null && raw !== "" ? Number(raw) : 8;
  if (!Number.isFinite(n) || n <= 0) return 8;
  return n;
}

function parseClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return null;
  }
  return h + min / 60;
}

function clockToSlot(hour: number): number {
  return Math.round(hour - GRID_START_HOUR);
}

/**
 * Parse SHIFTS from .env, e.g. GENERAL:09:00-17:00,B:14:00-22:00
 * Only shifts that fall entirely inside the fixed 8a–8p grid are kept.
 * Slot count is capped at MAX_DAILY_HOURS.
 */
export function getShifts(): ShiftConfig[] {
  const raw = process.env.SHIFTS?.trim() || "GENERAL:09:00-17:00";
  const maxHours = getMaxDailyHours();
  const out: ShiftConfig[] = [];

  for (const part of raw.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const match = /^([A-Za-z0-9_-]+):(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(piece);
    if (!match) {
      console.warn(`[config] Ignoring invalid SHIFTS entry: ${piece}`);
      continue;
    }
    const name = match[1];
    const startStr = match[2];
    const endStr = match[3];
    const start = parseClock(startStr);
    const end = parseClock(endStr);
    if (start == null || end == null || end <= start) {
      console.warn(`[config] Ignoring SHIFTS entry with bad times: ${piece}`);
      continue;
    }
    if (start < GRID_START_HOUR || end > GRID_END_HOUR + 1) {
      console.warn(
        `[config] Ignoring SHIFTS entry outside 8a–8p grid: ${piece} (extend grid later for evening shifts)`
      );
      continue;
    }

    const slots: number[] = [];
    for (let h = Math.floor(start); h < end; h++) {
      const slot = clockToSlot(h);
      if (slot < 0 || slot >= GRID_SLOT_COUNT) continue;
      slots.push(slot);
      if (slots.length >= maxHours) break;
    }
    if (!slots.length) {
      console.warn(`[config] Ignoring SHIFTS entry with no slots: ${piece}`);
      continue;
    }
    out.push({ name, start: startStr, end: endStr, hourSlots: slots });
  }

  if (!out.length) {
    // Safe default: 9a–5p → slots 1–8
    return [
      {
        name: "GENERAL",
        start: "09:00",
        end: "17:00",
        hourSlots: [1, 2, 3, 4, 5, 6, 7, 8].slice(0, maxHours),
      },
    ];
  }
  return out;
}
