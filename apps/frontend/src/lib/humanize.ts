/**
 * Turning machine-shaped data into something a person reads.
 *
 * Extracted from `lib/audit.ts`, which grew these first and still owns the
 * audit-specific parts. They live here because a second consumer appeared
 * (Media Intelligence renders fact sections and finding evidence, both of
 * which are raw keyed objects) and the alternative was a second, divergent
 * humanizer — two places to fix an acronym, two definitions of how a boolean
 * reads.
 *
 * Labels are deliberately English rather than translated. A derived label is
 * generated from a field name, not authored, so there is no key to translate;
 * the audit trail has rendered them this way since it shipped, and the
 * surrounding chrome (headings, statuses, reasons) is fully localized. A
 * half-translated panel would be worse than a consistently English one.
 */
import { formatBytes, formatDateTime, formatNumber } from './format';

/** Words that must not be title-cased into "Imdb" / "Id". */
const ACRONYMS: Record<string, string> = {
  id: 'ID', url: 'URL', ip: 'IP', imdb: 'IMDb', tmdb: 'TMDb', tvdb: 'TVDb',
  nfo: 'NFO', api: 'API', rss: 'RSS', scgi: 'SCGI', uuid: 'UUID', os: 'OS',
  db: 'DB', tv: 'TV', hd: 'HD', sd: 'SD', '2fa': '2FA', ok: 'OK',
  hdr: 'HDR', sdr: 'SDR', hevc: 'HEVC', avc: 'AVC', srt: 'SRT', pgs: 'PGS',
  // Codec tokens are spelled lowercase-x by convention; title-casing turns
  // `x265` into `X265`, which is simply wrong rather than merely ugly.
  x264: 'x264', x265: 'x265', av1: 'AV1', vp9: 'VP9', xvid: 'XviD',
  aac: 'AAC', ac3: 'AC3', eac3: 'EAC3', dts: 'DTS', truehd: 'TrueHD',
};

/** `libraryPath` / `library_path` / `library.path` → "Library path". */
export function prettifyKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => {
      const fix = ACRONYMS[w.toLowerCase()];
      if (fix) return fix;
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w.toLowerCase();
    })
    .join(' ');
}

/**
 * A free-form enum-ish value as a person reads it.
 *
 * `matchStatus`, `showStatus`, `libraryKind` and friends are plain columns, not
 * closed unions — the database can hold a value no UI enumerated. So this
 * title-cases whatever arrives rather than looking it up in a table that would
 * silently render nothing for an unexpected value.
 */
export function prettifyValue(value: string): string {
  const fix = ACRONYMS[value.toLowerCase()];
  if (fix) return fix;
  return value
    .replace(/[._-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ACRONYMS[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})/;
const BYTES_KEY = /bytes|size|freed|reclaimed/i;
const PERCENT_KEY = /percent$/i;
const SECONDS_KEY = /seconds$/i;
const HASH_LIKE = /^[a-f0-9]{16,}$/i;
/** An id is a machine handle; showing it as a number would be nonsense. */
const ID_KEY = /(^|[a-z])id$/i;

export const isScalar = (x: unknown): x is string | number | boolean =>
  x === null || ['string', 'number', 'boolean'].includes(typeof x);

/** A duration in seconds as "3h 42m" / "12m" — never a bare 13320. */
function formatDurationSeconds(total: number): string {
  if (!Number.isFinite(total) || total <= 0) return '0m';
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${formatNumber(hours)}h ${minutes}m` : `${formatNumber(hours)}h`;
  return `${minutes}m`;
}

/** Format a single scalar value, using the key for unit/format hints. */
export function formatScalar(
  key: string,
  v: string | number | boolean,
  prettifyEnums = false,
): { value: string; mono?: boolean } {
  if (typeof v === 'boolean') return { value: v ? 'Yes' : 'No' };
  if (typeof v === 'number') {
    if (BYTES_KEY.test(key)) return { value: formatBytes(v) };
    if (PERCENT_KEY.test(key)) return { value: `${Math.round(v)}%` };
    if (SECONDS_KEY.test(key)) return { value: formatDurationSeconds(v) };
    // An id that happens to be numeric is a handle, not a quantity.
    if (ID_KEY.test(key)) return { value: String(v), mono: true };
    return { value: formatNumber(v) };
  }
  if (ISO_DATE.test(v) && !Number.isNaN(new Date(v).getTime())) {
    return { value: formatDateTime(v) };
  }
  if (HASH_LIKE.test(v) || v.includes('/')) return { value: v, mono: true };
  /*
   * A short lowercase token is almost always an enum, and reads better
   * title-cased — but only where the caller asked for it. The audit trail
   * deliberately shows machine codes verbatim so an operator can match what
   * they see against the underlying action, so prettifying is opt-in rather
   * than something extraction silently imposed on an existing consumer.
   */
  if (prettifyEnums && /^[a-z][a-z0-9_-]*$/.test(v) && v.length <= 24) {
    return { value: prettifyValue(v) };
  }
  return { value: v };
}

export interface HumanField {
  /** Human label derived from the key, e.g. `libraryPath` → "Library path". */
  label: string;
  /** Humanized scalar value; `null` when this field is a nested `json` blob. */
  value: string | null;
  /** Pretty-printed JSON — the deliberate fallback for nested/complex values. */
  json?: string;
  /** Render the value monospaced (hashes, ids, paths). */
  mono?: boolean;
}

/**
 * Turn a raw keyed object into human-readable fields: labels are
 * de-camelCased/acronym-fixed, and values are formatted by type (bytes,
 * counts, percentages, durations, dates, Yes/No, scalar arrays joined). The
 * **one** deliberate exception — the "good reason" to keep JSON — is a
 * genuinely nested value (an object, or an array of objects), which has no
 * flat human form; those are returned as pretty-printed `json` so nothing is
 * lost. Empty/null fields are dropped.
 *
 * `omit` lets a caller drop envelope keys it renders itself (status, source,
 * observedAt) without having to post-filter the result.
 */
export function humanizeFields(
  input: unknown,
  omit: readonly string[] = [],
  prettifyEnums = true,
): HumanField[] {
  if (!input || typeof input !== 'object') return [];
  const skip = new Set(omit);
  const out: HumanField[] = [];
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (skip.has(key)) continue;
    if (raw === null || raw === undefined || raw === '') continue;
    const label = prettifyKey(key);

    if (Array.isArray(raw)) {
      if (raw.length === 0) continue;
      if (raw.every(isScalar)) {
        out.push({
          label,
          value: raw
            .filter((x) => x != null)
            .map((x) => (prettifyEnums && typeof x === 'string' ? prettifyValue(x) : String(x)))
            .join(', '),
        });
      } else {
        out.push({ label, value: null, json: JSON.stringify(raw, null, 2) });
      }
      continue;
    }
    if (typeof raw === 'object') {
      out.push({ label, value: null, json: JSON.stringify(raw, null, 2) });
      continue;
    }
    const { value, mono } = formatScalar(key, raw as string | number | boolean, prettifyEnums);
    out.push({ label, value, mono });
  }
  return out;
}
