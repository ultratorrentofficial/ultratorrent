import type { EffectivePolicy } from './policy';

/**
 * Recurring windows that override limits by time of day.
 *
 * Evaluated from the clock, holding no state. That is what makes the awkward
 * cases harmless: a restart loses nothing because there is nothing to lose, and
 * a clock moved backwards simply produces the answer for the earlier time
 * instead of corrupting a schedule that had already "fired". Nothing here fires;
 * a window is either covering this instant or it is not.
 *
 * Wall-clock, not UTC. An operator who says "throttle overnight" means their
 * night, and their night moves twice a year. Asking `Intl` for the local time in
 * the window's own zone gets daylight saving right for free — including the two
 * pathological days, where a window inside the skipped hour never occurs and one
 * inside the repeated hour occurs twice. Both are the correct reading of what
 * the operator wrote.
 */

export interface ScheduleWindow {
  id: string;
  name: string;
  enabled: boolean;
  /** 0 = Sunday … 6 = Saturday, in the window's own timezone. */
  daysOfWeek: number[];
  /** Minutes from local midnight, 0…1439. */
  startMinute: number;
  endMinute: number;
  /** IANA zone. An unrecognised one makes the window inert, never crashes. */
  timeZone: string;
  /** Higher wins when windows overlap. */
  priority: number;

  maxConcurrentDownloads?: number | null;
  maxConcurrentSeeds?: number | null;
  maxTotalActive?: number | null;
  maxDownloadRateKbps?: number | null;
  maxUploadRateKbps?: number | null;
  /** When false, nothing new starts downloading while this window is open. */
  allowNewDownloads?: boolean;
}

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Local wall-clock position, or null when the zone is not recognised. */
export function localPosition(
  now: Date,
  timeZone: string,
): { minutes: number; weekday: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    }).formatToParts(now);

    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const weekday = WEEKDAYS[get('weekday') ?? ''];
    // `hour12: false` yields 24 for midnight in some environments.
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    if (weekday === undefined || Number.isNaN(hour) || Number.isNaN(minute)) return null;
    return { minutes: hour * 60 + minute, weekday };
  } catch {
    // An invalid IANA zone must not take the sweep down with it.
    return null;
  }
}

/** A window whose definition cannot be honoured, and why. */
export function windowIsValid(w: ScheduleWindow): boolean {
  if (!w.daysOfWeek?.length) return false;
  if (w.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return false;
  for (const m of [w.startMinute, w.endMinute]) {
    if (!Number.isInteger(m) || m < 0 || m > 1439) return false;
  }
  // Zero-length is almost certainly a mistake, and treating it as "always" or
  // "never" would both be guesses about intent.
  if (w.startMinute === w.endMinute) return false;
  return true;
}

/**
 * Is this window covering `now`?
 *
 * A window that ends before it starts crosses midnight, and the day-of-week test
 * then applies to the day it BEGAN on — "Friday 22:00–02:00" runs into Saturday
 * morning without Saturday being selected, which is what an operator means when
 * they tick Friday.
 */
export function windowCovers(w: ScheduleWindow, now: Date): boolean {
  if (!w.enabled || !windowIsValid(w)) return false;
  const pos = localPosition(now, w.timeZone);
  if (!pos) return false;

  const today = w.daysOfWeek.includes(pos.weekday);
  if (w.startMinute < w.endMinute) {
    return today && pos.minutes >= w.startMinute && pos.minutes < w.endMinute;
  }

  // Crosses midnight.
  const yesterday = w.daysOfWeek.includes((pos.weekday + 6) % 7);
  if (today && pos.minutes >= w.startMinute) return true;
  return yesterday && pos.minutes < w.endMinute;
}

/**
 * The windows in force, most authoritative first.
 *
 * Ties break on id so two windows of equal priority always resolve the same way
 * — an overlap that resolved differently between sweeps would make the schedule
 * flap.
 */
export function activeWindows(windows: ScheduleWindow[], now: Date): ScheduleWindow[] {
  return windows
    .filter((w) => windowCovers(w, now))
    .sort((a, b) => (b.priority - a.priority) || a.id.localeCompare(b.id));
}

/**
 * Fold the active windows into a policy.
 *
 * Applied over the resolved policy rather than into the scope chain: a schedule
 * is a temporary override of whatever the scopes decided, not another scope. The
 * highest-priority window that specifies a field wins it, so a broad "overnight"
 * window can set a rate while a narrow "maintenance" window on top of it sets
 * only concurrency.
 *
 * `allowNewDownloads: false` is carried as its own flag rather than folded into
 * a concurrency ceiling of zero. They are different promises: a ceiling of zero
 * would put every download already in flight over the limit and pause it, while
 * what the operator asked for is that nothing NEW starts. Stopping work already
 * running because a window opened is a far stronger action than declining to
 * begin more, and conflating them would surprise anyone who ticked the box.
 */
export interface ScheduledPolicy extends EffectivePolicy {
  /** Which windows shaped this, for the UI to explain the current state. */
  activeWindowIds: string[];
  /** False while a window forbids starting anything new. */
  allowNewDownloads: boolean;
}

export function applySchedule(
  policy: EffectivePolicy,
  windows: ScheduleWindow[],
  now: Date,
): ScheduledPolicy {
  const active = activeWindows(windows, now);
  const out: ScheduledPolicy = {
    ...policy,
    sources: { ...policy.sources },
    activeWindowIds: active.map((w) => w.id),
    allowNewDownloads: true,
  };

  // Walk from the LEAST authoritative so higher priority overwrites it.
  for (const w of [...active].reverse()) {
    const take = <K extends keyof EffectivePolicy>(field: K, value: unknown) => {
      if (value === undefined) return;
      (out as unknown as Record<string, unknown>)[field as string] = value ?? null;
      out.sources[field as keyof typeof out.sources] = `schedule:${w.id}`;
    };
    take('maxConcurrentDownloads', w.maxConcurrentDownloads);
    take('maxConcurrentSeeds', w.maxConcurrentSeeds);
    take('maxTotalActive', w.maxTotalActive);
    take('maxDownloadRateKbps', w.maxDownloadRateKbps);
    take('maxUploadRateKbps', w.maxUploadRateKbps);
    if (w.allowNewDownloads === false) out.allowNewDownloads = false;
  }

  return out;
}
