/**
 * When a scheduled newsletter should next go out.
 *
 * The old rule was `lastSend + 7 days`, stamped when a send finished. Nothing
 * named a weekday or a time, so the slot was whatever moment someone first
 * pressed "Send now", and it drifted later every week because the next slot was
 * measured from completion while the dispatcher only polls every 15 minutes.
 * On the live install one pair of newsletters had settled on "Friday 16:04
 * UTC" for no reason anybody chose.
 *
 * Here the schedule is stated: a weekday, a local time, and the zone that time
 * is written in. The zone is not decoration — the containers run UTC while the
 * hosts are AST, so an unqualified "09:00" lands at 05:00 local.
 */

export interface SendSchedule {
  frequency: string;
  /** 0=Sunday … 6=Saturday. Null means "keep the legacy relative cadence". */
  sendWeekday?: number | null;
  sendHour?: number | null;
  sendMinute?: number | null;
  timezone?: string | null;
}

const DAY_MS = 24 * 3600 * 1000;

/** The wall-clock reading in `tz` for an instant, as numeric parts. */
function partsIn(instant: Date, tz: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(instant)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  // `hour12:false` renders midnight as 24 in some ICU versions.
  if (out.hour === 24) out.hour = 0;
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Zone offset in ms at an instant: (wall clock read as UTC) − (real instant). */
function offsetAt(instant: Date, tz: string): number {
  const p = partsIn(instant, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime();
}

/**
 * The instant at which the wall clock in `tz` reads the given local time.
 *
 * Applied twice: the first offset is sampled at a guessed instant, which is the
 * wrong side of a DST boundary for the hour or two around a transition. Solving
 * again with the corrected offset lands on the right side.
 */
export function fromZonedTime(
  y: number, month: number, day: number, hour: number, minute: number, tz: string,
): Date {
  const guess = Date.UTC(y, month - 1, day, hour, minute);
  const first = new Date(guess - offsetAt(new Date(guess), tz));
  const second = new Date(guess - offsetAt(first, tz));
  return second;
}

/** Day of week (0=Sunday) as read in `tz`. */
function weekdayIn(instant: Date, tz: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(instant);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}

function safeZone(tz?: string | null): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC'; // an unknown zone must not stop a newsletter from ever sending
  }
}

/**
 * The next send instant strictly after `from`, or null for a manual newsletter.
 *
 * Anchored to the calendar rather than to the previous send, so a run that
 * fires late — the dispatcher polls on an interval, and a slow send takes
 * minutes — does not push every future send later. Missing a slot entirely
 * (the process was down) simply schedules the following one; the newsletter
 * covers the gap anyway, because its window is "everything since the last
 * successful send".
 */
export function nextRunAt(schedule: SendSchedule, from: Date): Date | null {
  const { frequency } = schedule;
  if (frequency === 'manual') return null;

  const tz = safeZone(schedule.timezone);
  const hour = clamp(schedule.sendHour ?? 9, 0, 23);
  const minute = clamp(schedule.sendMinute ?? 0, 0, 59);

  if (frequency === 'daily') return nextDaily(from, hour, minute, tz);

  if (frequency === 'weekly') {
    // No weekday chosen: keep the historical relative cadence rather than
    // silently moving an existing newsletter to a day nobody picked.
    if (schedule.sendWeekday == null) return new Date(from.getTime() + 7 * DAY_MS);
    return nextWeekly(from, clamp(schedule.sendWeekday, 0, 6), hour, minute, tz);
  }

  if (frequency === 'monthly') {
    if (schedule.sendWeekday == null) return new Date(from.getTime() + 30 * DAY_MS);
    return nextMonthly(from, hour, minute, tz);
  }

  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function nextDaily(from: Date, hour: number, minute: number, tz: string): Date {
  const p = partsIn(from, tz);
  const today = fromZonedTime(p.year, p.month, p.day, hour, minute, tz);
  if (today > from) return today;
  const tomorrow = partsIn(new Date(from.getTime() + DAY_MS), tz);
  return fromZonedTime(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, tz);
}

function nextWeekly(from: Date, weekday: number, hour: number, minute: number, tz: string): Date {
  for (let add = 0; add <= 7; add += 1) {
    const probe = new Date(from.getTime() + add * DAY_MS);
    if (weekdayIn(probe, tz) !== weekday) continue;
    const p = partsIn(probe, tz);
    const candidate = fromZonedTime(p.year, p.month, p.day, hour, minute, tz);
    if (candidate > from) return candidate;
  }
  // Only reachable when today is the chosen day and its time has passed: the
  // loop above skipped it, so the answer is that weekday next week.
  const probe = new Date(from.getTime() + 7 * DAY_MS);
  const p = partsIn(probe, tz);
  return fromZonedTime(p.year, p.month, p.day, hour, minute, tz);
}

/** Same day-of-month next month, clamped to a short month's last day. */
function nextMonthly(from: Date, hour: number, minute: number, tz: string): Date {
  const p = partsIn(from, tz);
  const thisMonth = fromZonedTime(p.year, p.month, p.day, hour, minute, tz);
  if (thisMonth > from) return thisMonth;
  const y = p.month === 12 ? p.year + 1 : p.year;
  const m = p.month === 12 ? 1 : p.month + 1;
  const lastDay = new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 0)).getUTCDate();
  return fromZonedTime(y, m, Math.min(p.day, lastDay), hour, minute, tz);
}
