/**
 * Human-friendly formatting helpers for sizes, transfer speeds, durations and
 * dates. Pure functions, safe for render-time use.
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Format a byte count using binary (1024) units, e.g. 1536 -> "1.50 KB". */
export function formatBytes(bytes: number | null | undefined, fractionDigits = 2): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  const value = bytes / Math.pow(1024, exponent);
  const digits = exponent === 0 ? 0 : fractionDigits;
  return `${value.toFixed(digits)} ${BYTE_UNITS[exponent]}`;
}

/** Format bytes-per-second, e.g. "4.20 MB/s". Zero renders as an em dash. */
export function formatSpeed(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** Compact speed for dense UI (top bar), e.g. "4.2 MB/s". */
export function formatSpeedCompact(bytesPerSecond: number | null | undefined): string {
  if (!bytesPerSecond || bytesPerSecond <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSecond, 1)}/s`;
}

/**
 * Format an ETA expressed in seconds into a compact duration, e.g. "2h 5m".
 * `null`/non-finite (e.g. seeding) renders as "∞".
 */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '∞';
  if (seconds === 0) return '0s';
  if (seconds >= 8640000) return '∞';

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && parts.length < 2) parts.push(`${minutes}m`);
  if (secs && parts.length < 2 && !days && !hours) parts.push(`${secs}s`);
  return parts.slice(0, 2).join(' ') || '0s';
}

/** Format a 0..1 progress fraction as a whole-number percentage string. */
export function formatPercent(fraction: number | null | undefined, fractionDigits = 1): string {
  if (fraction == null || !Number.isFinite(fraction)) return '0%';
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  const digits = pct === 100 || pct === 0 ? 0 : fractionDigits;
  return `${pct.toFixed(digits)}%`;
}

/** Format a share ratio, capping the display of unbounded ratios. */
export function formatRatio(ratio: number | null | undefined): string {
  if (ratio == null || !Number.isFinite(ratio) || ratio < 0) return '0.00';
  if (ratio >= 10000) return '∞';
  return ratio.toFixed(2);
}

/** Format an absolute date/time from an ISO string. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Compact relative time, e.g. "3m ago" / "in 2h". */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const diffMs = date.getTime() - Date.now();
  const abs = Math.abs(diffMs);
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  const suffix = diffMs <= 0 ? ' ago' : '';
  const prefix = diffMs > 0 ? 'in ' : '';

  let core: string;
  if (sec < 45) core = `${sec}s`;
  else if (min < 60) core = `${min}m`;
  else if (hr < 24) core = `${hr}h`;
  else if (day < 30) core = `${day}d`;
  else return formatDateTime(iso);

  return `${prefix}${core}${suffix}`;
}

/**
 * {@link formatRelativeTime}, but it never falls back to a full timestamp.
 *
 * Past 30 days the relative form gives up and returns a date AND a time ("May 30, 2026,
 * 02:11 PM"). That is ~140px of text, which no sane table column affords — in a list it
 * truncates to a useless "May 30, 202…", losing the year. Most torrents in a library are
 * older than a month, so that is the common case, not the edge case. Drop the time and
 * keep the date; callers put the exact timestamp in a tooltip.
 */
export function formatRelativeTimeShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const days = Math.abs(date.getTime() - Date.now()) / 86_400_000;
  if (days < 30) return formatRelativeTime(iso);
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Pluralize a count with a unit, e.g. count(2, "peer") -> "2 peers". */
export function pluralize(count: number, unit: string): string {
  return `${count.toLocaleString()} ${unit}${count === 1 ? '' : 's'}`;
}

/** Format an integer with grouping separators. */
export function formatNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '0';
  return value.toLocaleString();
}
