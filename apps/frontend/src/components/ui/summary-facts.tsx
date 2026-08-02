import { Fragment } from 'react';
import { formatBytes, formatDateTime, formatNumber } from '@/lib/format';

/**
 * Render a structured summary as readable facts, never as JSON.
 *
 * The Jobs Center used to print `inputSummary` through `JSON.stringify`, and a
 * user opening a completed metadata refresh was shown a blob containing
 * `"itemId": null, "libraryId": null` — and reasonably concluded the job had no
 * idea what to work on. It had: the job carried its item, and `libraryId` is
 * null BY DESIGN on that path, because a selection can span libraries. The data
 * was fine and the presentation lied about it.
 *
 * So this does three things a dump cannot:
 *
 *  - **Omits what is not set.** A missing value is absence, and printing `null`
 *    turns absence into an assertion of failure. This is the fix for the actual
 *    complaint, not a cosmetic one.
 *  - **Reads keys as words.** `libraryId` → "Library", `itemIds` → "Items",
 *    `totalSavingsBytes` → "Total savings". Camel case is a programming
 *    convention, not a language.
 *  - **Formats by meaning.** Byte counts as sizes, timestamps as dates, booleans
 *    as yes/no, arrays as a count and a sample rather than a wall of ids.
 *
 * Deliberately no "show raw" escape hatch. An operator surface should not teach
 * people to read JSON to find out what happened.
 */

/** Keys whose value is a byte count, however they are spelled. */
const BYTE_KEY = /(bytes|size|savings)$/i;
/** Keys whose value is an ISO timestamp. */
const DATE_KEY = /(at|date|time)$/i;
/** Keys that carry an opaque identifier — shown short, since the full value tells nobody anything. */
const ID_KEY = /(^id$|id$|ids$)/i;

/** `totalSavingsBytes` → `Total savings`, `itemIds` → `Items`. */
export function humanizeKey(key: string): string {
  let words = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ');

  // "Id" carries no meaning to a reader — "Library Id" is just "Library" — but
  // "Ids" also carries the PLURAL, and dropping it whole turns a list of items
  // into "Item", which reads as one.
  const last = words[words.length - 1];
  if (/^ids$/i.test(last) && words.length > 1) {
    words = words.slice(0, -1);
    const noun = words[words.length - 1];
    words[words.length - 1] = /s$/i.test(noun) ? noun : `${noun}s`;
  }

  words = words
    .filter((w) => !/^(id|uuid)$/i.test(w))
    // Units belong in the value, not the label.
    .filter((w) => !/^(bytes|ms|sec|secs)$/i.test(w));
  if (!words.length) return key;
  const first = words[0];
  return [first.charAt(0).toUpperCase() + first.slice(1).toLowerCase(), ...words.slice(1).map((w) => w.toLowerCase())]
    .join(' ');
}

/** A UUID reduced to something a human can compare at a glance. */
function shortId(v: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(v) ? v.slice(0, 8) : v;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

function formatScalar(key: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') {
    if (BYTE_KEY.test(key)) return formatBytes(v);
    return formatNumber(v);
  }
  if (typeof v === 'string') {
    // An ISO timestamp is unreadable raw and trivially readable formatted.
    if (DATE_KEY.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatDateTime(v);
    if (ID_KEY.test(key)) return shortId(v);
    return v;
  }
  return String(v);
}

function Row({ label, value, depth }: { label: string; value: React.ReactNode; depth: number }) {
  return (
    <div
      className="flex items-baseline justify-between gap-3 py-0.5 text-sm"
      style={depth ? { paddingLeft: depth * 12 } : undefined}
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-right font-medium">{value}</span>
    </div>
  );
}

function Entries({ value, depth }: { value: unknown; depth: number }) {
  // A bare scalar at the top level still deserves a line rather than nothing.
  if (value === null || typeof value !== 'object') {
    return <Row label="Value" value={String(value)} depth={depth} />;
  }

  if (Array.isArray(value)) {
    return (
      <>
        {value.slice(0, 5).map((v, i) => (
          <Fragment key={i}>
            {v !== null && typeof v === 'object' ? (
              <Entries value={v} depth={depth + 1} />
            ) : (
              <Row label={`#${i + 1}`} value={formatScalar('', v)} depth={depth} />
            )}
          </Fragment>
        ))}
        {value.length > 5 ? (
          <Row label="" value={`…and ${formatNumber(value.length - 5)} more`} depth={depth} />
        ) : null}
      </>
    );
  }

  return (
    <>
      {Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        // The whole point: an unset value is not news, and printing it as `null`
        // reads as a malfunction.
        if (isEmpty(v)) return null;

        if (Array.isArray(v)) {
          const scalars = v.every((x) => x === null || typeof x !== 'object');
          if (scalars) {
            const sample = v.slice(0, 3).map((x) => formatScalar(k, x)).join(', ');
            return (
              <Row
                key={k}
                label={humanizeKey(k)}
                value={v.length > 3 ? `${formatNumber(v.length)} — ${sample}…` : sample}
                depth={depth}
              />
            );
          }
          return (
            <Fragment key={k}>
              <Row label={humanizeKey(k)} value={`${formatNumber(v.length)}`} depth={depth} />
              <Entries value={v.slice(0, 3)} depth={depth + 1} />
            </Fragment>
          );
        }

        if (typeof v === 'object') {
          return (
            <Fragment key={k}>
              <Row label={humanizeKey(k)} value="" depth={depth} />
              <Entries value={v} depth={depth + 1} />
            </Fragment>
          );
        }

        return <Row key={k} label={humanizeKey(k)} value={formatScalar(k, v)} depth={depth} />;
      })}
    </>
  );
}

export interface SummaryFactsProps {
  label: string;
  value: unknown;
  /** Shown when every field was empty — otherwise the section renders blank. */
  emptyText?: string;
}

export function SummaryFacts({ label, value, emptyText }: SummaryFactsProps) {
  const empty = isEmpty(value);
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label}</h3>
      {empty ? (
        <p className="text-sm text-muted-foreground">{emptyText ?? '—'}</p>
      ) : (
        <div className="rounded-lg bg-white/[0.03] px-3 py-2">
          <Entries value={value} depth={0} />
        </div>
      )}
    </div>
  );
}

/**
 * One line of readable text for a value that would otherwise be stringified.
 *
 * `SummaryFacts` is a block; plenty of places need the same treatment inside a
 * single table cell or property row, where a `<pre>` would wreck the layout and
 * `JSON.stringify` produces `{"width":1920,"height":1080}` for a user to squint
 * at. Same rules — omit what is not set, format by meaning, never show braces.
 */
export function summarizeValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    if (value.length === 0) return '—';
    if (depth > 0) return `${formatNumber(value.length)} items`;
    const shown = value.slice(0, 3).map((v) => summarizeValue(v, depth + 1));
    return value.length > 3
      ? `${shown.join(', ')} …and ${formatNumber(value.length - 3)} more`
      : shown.join(', ');
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => !isEmpty(v));
  if (!entries.length) return '—';
  // Nested objects collapse rather than recursing forever inside one line.
  if (depth > 0) return `${formatNumber(entries.length)} fields`;
  return entries
    .slice(0, 4)
    .map(([k, v]) => `${humanizeKey(k)}: ${summarizeValue(v, depth + 1)}`)
    .join(' · ') + (entries.length > 4 ? ` · …and ${formatNumber(entries.length - 4)} more` : '');
}
