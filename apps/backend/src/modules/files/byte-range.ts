/**
 * HTTP Range parsing for the media stream route.
 *
 * Seeking a video is a Range request: the player asks for the bytes around the
 * timestamp someone clicked and expects a `206` with exactly that window. Serve
 * `200` with the whole file instead and the scrubber goes dead — the browser
 * cannot seek in a response it must read from the start.
 *
 * Pure: bytes in, offsets out. Single range only; a multipart range response is
 * something no `<video>` element asks for.
 */

export interface ByteRange {
  start: number;
  /** Inclusive, as `Content-Range` counts. */
  end: number;
}

/**
 * Parse a `Range` header against a known file size.
 *
 * - `undefined` — no range asked for, send the whole file.
 * - a `ByteRange` — send `206` with these offsets.
 * - `'unsatisfiable'` — send `416`; the client asked past the end of the file.
 */
export function parseByteRange(
  header: string | undefined | null,
  size: number,
): ByteRange | undefined | 'unsatisfiable' {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return undefined; // multipart or malformed — fall back to the whole file
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return undefined;

  // An empty file can satisfy no range at all, not even `bytes=0-`.
  if (size === 0) return 'unsatisfiable';

  if (rawStart === '') {
    // Suffix form: `bytes=-500` means the LAST 500 bytes, not the first 500.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable';
  // An open-ended `bytes=1000-` runs to the end; a stated end past EOF is clamped
  // rather than rejected, which is what RFC 9110 requires.
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';
  return { start, end };
}
