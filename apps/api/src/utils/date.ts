export function parseDateOnly(value: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) throw new Error(`Invalid date: ${value}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function formatDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Previous calendar day (simple; weekends still carry for demo). */
export function previousWorkDate(d: Date): Date {
  const prev = new Date(d);
  prev.setUTCDate(prev.getUTCDate() - 1);
  return prev;
}

export function startOfFrequency(date: Date, frequency: "daily" | "weekly" | "monthly"): Date {
  if (frequency === "daily") return date;
  if (frequency === "weekly") {
    const day = date.getUTCDay(); // 0 Sun
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const start = new Date(date);
    start.setUTCDate(start.getUTCDate() + mondayOffset);
    return start;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function endOfFrequency(date: Date, frequency: "daily" | "weekly" | "monthly"): Date {
  if (frequency === "daily") return date;
  if (frequency === "weekly") {
    const start = startOfFrequency(date, "weekly");
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    return end;
  }
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}
