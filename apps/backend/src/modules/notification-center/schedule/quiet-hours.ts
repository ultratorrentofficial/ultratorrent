/**
 * Quiet-hours and digest timing.
 *
 * All of it is computed in the RECIPIENT's timezone, never the server's. A person in
 * Puerto Rico and one in Madrid have different nights, and a server that reasons in
 * UTC would wake exactly the wrong one.
 */

export interface QuietHoursConfig {
  quietHoursEnabled: boolean;
  /** IANA zone. Null falls back to the server zone. */
  timezone?: string | null;
  /** Local "HH:mm". */
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  /** Days the window applies to, 0 = Sunday. Empty = every day. */
  quietHoursDays?: number[];
}

/** Local wall-clock parts of an instant in a given zone. */
export interface LocalParts {
  /** 0 = Sunday. */
  weekday: number;
  hour: number;
  minute: number;
  /** Minutes since local midnight. */
  minutesOfDay: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/**
 * Wall-clock parts of `at` in `timezone`.
 *
 * Uses `Intl` rather than manual offset arithmetic so daylight-saving transitions
 * are handled by the platform's tz database. An invalid zone falls back to the
 * server's rather than throwing: a malformed profile must not stop a notification.
 */
export function localParts(at: Date, timezone?: string | null): LocalParts {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || undefined,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(at);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  // `hour12: false` can render midnight as "24" in some environments.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0;
  return { weekday, hour, minute, minutesOfDay: hour * 60 + minute };
}

/** "22:30" → 1350. Returns null for anything unparseable. */
export function parseHhMm(value?: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Is `at` inside the user's quiet hours?
 *
 * Handles the overnight case explicitly: 22:00–07:00 does not mean "between 22:00
 * and 07:00 on the same day", it wraps midnight, and treating it as a simple range
 * would make the window empty — silently disabling quiet hours for everyone who
 * sets a normal night.
 *
 * The day-of-week test uses the day the window STARTED on. For an overnight window,
 * 01:00 on Saturday belongs to Friday's window; testing Saturday would end the quiet
 * period at midnight, which is not what "Friday 22:00–07:00" means.
 */
export function isWithinQuietHours(config: QuietHoursConfig, at: Date): boolean {
  if (!config.quietHoursEnabled) return false;
  const start = parseHhMm(config.quietHoursStart);
  const end = parseHhMm(config.quietHoursEnd);
  if (start == null || end == null) return false;
  // An empty window is not a 24-hour window.
  if (start === end) return false;

  const { weekday, minutesOfDay } = localParts(at, config.timezone);
  const days = config.quietHoursDays ?? [];
  const appliesOn = (day: number) => days.length === 0 || days.includes(day);

  if (start < end) {
    // Same-day window, e.g. 13:00–15:00.
    return minutesOfDay >= start && minutesOfDay < end && appliesOn(weekday);
  }
  // Overnight window, e.g. 22:00–07:00.
  if (minutesOfDay >= start) {
    return appliesOn(weekday); // evening portion — the window starts today
  }
  if (minutesOfDay < end) {
    const startedYesterday = (weekday + 6) % 7;
    return appliesOn(startedYesterday); // morning portion — it started yesterday
  }
  return false;
}

/**
 * When the current quiet period ends, as an instant.
 *
 * Used to schedule a queued notification for release. Computed by stepping forward
 * in whole minutes rather than by date arithmetic, so a DST shift inside the window
 * cannot land the release time inside the window it was meant to escape.
 */
export function quietHoursEndAt(config: QuietHoursConfig, at: Date, maxMinutes = 24 * 60): Date {
  if (!isWithinQuietHours(config, at)) return at;
  const step = 5;
  for (let elapsed = step; elapsed <= maxMinutes; elapsed += step) {
    const candidate = new Date(at.getTime() + elapsed * 60_000);
    if (!isWithinQuietHours(config, candidate)) return candidate;
  }
  // A window that never ends is a misconfiguration; release after the cap rather
  // than holding the notification forever.
  return new Date(at.getTime() + maxMinutes * 60_000);
}

export interface DigestConfig {
  timezone?: string | null;
  digestDaily: boolean;
  digestDailyAt?: string | null;
  digestWeekly: boolean;
  /** 0 = Sunday. */
  digestWeeklyDay?: number | null;
  digestWeeklyAt?: string | null;
}

/**
 * The next instant a daily digest is due, at or after `from`.
 *
 * Returns null when daily digests are off. Like the quiet-hours release, this steps
 * forward in minutes in the user's own zone rather than assuming a fixed day length.
 */
export function nextDailyDigestAt(config: DigestConfig, from: Date): Date | null {
  if (!config.digestDaily) return null;
  const target = parseHhMm(config.digestDailyAt) ?? 8 * 60; // 08:00 default
  return nextLocalTime(from, config.timezone, target, null);
}

/** The next instant a weekly digest is due, or null when weekly digests are off. */
export function nextWeeklyDigestAt(config: DigestConfig, from: Date): Date | null {
  if (!config.digestWeekly) return null;
  const target = parseHhMm(config.digestWeeklyAt) ?? 8 * 60;
  const day = config.digestWeeklyDay ?? 1; // Monday default
  return nextLocalTime(from, config.timezone, target, day);
}

/**
 * The next instant whose local time is `targetMinutes` (and local weekday is
 * `targetDay`, when given), strictly after `from`.
 *
 * Scans minute by minute from the next minute. Bounded to eight days so a
 * misconfiguration cannot spin, and the coarse cost is irrelevant — this runs once
 * per user per digest, not per notification.
 */
function nextLocalTime(
  from: Date,
  timezone: string | null | undefined,
  targetMinutes: number,
  targetDay: number | null,
): Date {
  const limit = 8 * 24 * 60;
  for (let i = 1; i <= limit; i += 1) {
    const candidate = new Date(from.getTime() + i * 60_000);
    const p = localParts(candidate, timezone);
    if (p.minutesOfDay !== targetMinutes) continue;
    if (targetDay != null && p.weekday !== targetDay) continue;
    return candidate;
  }
  return new Date(from.getTime() + 24 * 60 * 60_000);
}
