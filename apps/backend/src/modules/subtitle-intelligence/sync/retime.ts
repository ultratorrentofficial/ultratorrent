/**
 * Pure subtitle re-timing. Shifts every timestamp in an SRT / WebVTT / ASS
 * subtitle by a constant offset and/or a linear drift factor, preserving the
 * file's exact format (it rewrites only the timestamp tokens, leaving text,
 * styling, and structure untouched). No IO — trivially unit-testable.
 *
 * `new = max(0, round(t * driftFactor + offsetMs))` — a negative offset that
 * would push a cue before zero is clamped to 0 (a subtitle cannot start before
 * the film does).
 */

const pad = (n: number, w: number): string => String(n).padStart(w, '0');

/** Apply the linear transform, clamped at zero. Pure. */
export function applyTiming(ms: number, offsetMs: number, driftFactor: number): number {
  return Math.max(0, Math.round(ms * driftFactor + offsetMs));
}

/** ms → `HH:MM:SS,mmm` (SRT) or `HH:MM:SS.mmm` (VTT), by separator. Pure. */
export function msToClock(ms: number, sep: ',' | '.'): string {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3_600_000);
  const m = Math.floor((v % 3_600_000) / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  const frac = v % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(frac, 3)}`;
}

/** ms → `H:MM:SS.cc` (ASS centiseconds). Pure. */
export function msToAss(ms: number): string {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3_600_000);
  const m = Math.floor((v % 3_600_000) / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  const cs = Math.floor((v % 1000) / 10);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

/**
 * Shift every timestamp in `content` by offset/drift, format-aware. Returns the
 * re-timed text. `driftFactor` defaults to 1 (offset only). Pure.
 */
export function shiftTimestamps(
  content: string,
  format: string,
  offsetMs: number,
  driftFactor = 1,
): string {
  const f = format.toLowerCase().replace(/^\./, '');

  if (f === 'ass' || f === 'ssa') {
    // ASS `H:MM:SS.cc` (centiseconds).
    return content.replace(/(\d{1,2}):(\d{2}):(\d{2})\.(\d{2})/g, (_m, h, mn, s, cs) => {
      const ms = ((+h * 60 + +mn) * 60 + +s) * 1000 + +cs * 10;
      return msToAss(applyTiming(ms, offsetMs, driftFactor));
    });
  }

  // SRT `HH:MM:SS,mmm` / VTT `HH:MM:SS.mmm`. Keep whichever separator each token
  // used, so a mixed file (rare) still round-trips faithfully.
  return content.replace(/(\d{1,2}):(\d{2}):(\d{2})([,.])(\d{1,3})/g, (_m, h, mn, s, sepChar, frac) => {
    const ms = ((+h * 60 + +mn) * 60 + +s) * 1000 + Number(String(frac).padEnd(3, '0').slice(0, 3));
    return msToClock(applyTiming(ms, offsetMs, driftFactor), sepChar === '.' ? '.' : ',');
  });
}
