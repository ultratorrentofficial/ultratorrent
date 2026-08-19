/**
 * Turning arbitrary bytes into readable text for the preview surface.
 *
 * The old preview did `readFile(target, 'utf8')`, which is right for maybe half
 * of what a download directory holds. A scene NFO is CP437 — its box-drawing art
 * decodes to replacement characters under UTF-8 — and subtitles ripped in Europe
 * are routinely Latin-1. Both came out as mojibake with no way to correct them.
 *
 * Pure, no IO: the caller reads the bytes, this decides what they say.
 */

import type { PreviewTextEncoding } from '@ultratorrent/shared';

/**
 * Code page 437 (the original IBM PC character set), high half only — 0x80–0xFF.
 * The low half is ASCII and needs no table.
 *
 * This is what makes an NFO legible: the single/double box-drawing runs, block
 * shading and arrows that scene art is built from all live up here.
 */
const CP437_HIGH = [
  'Ç', 'ü', 'é', 'â', 'ä', 'à', 'å', 'ç', 'ê', 'ë', 'è', 'ï', 'î', 'ì', 'Ä', 'Å',
  'É', 'æ', 'Æ', 'ô', 'ö', 'ò', 'û', 'ù', 'ÿ', 'Ö', 'Ü', '¢', '£', '¥', '₧', 'ƒ',
  'á', 'í', 'ó', 'ú', 'ñ', 'Ñ', 'ª', 'º', '¿', '⌐', '¬', '½', '¼', '¡', '«', '»',
  '░', '▒', '▓', '│', '┤', '╡', '╢', '╖', '╕', '╣', '║', '╗', '╝', '╜', '╛', '┐',
  '└', '┴', '┬', '├', '─', '┼', '╞', '╟', '╚', '╔', '╩', '╦', '╠', '═', '╬', '╧',
  '╨', '╤', '╥', '╙', '╘', '╒', '╓', '╫', '╪', '┘', '┌', '█', '▄', '▌', '▐', '▀',
  'α', 'ß', 'Γ', 'π', 'Σ', 'σ', 'µ', 'τ', 'Φ', 'Θ', 'Ω', 'δ', '∞', 'φ', 'ε', '∩',
  '≡', '±', '≥', '≤', '⌠', '⌡', '÷', '≈', '°', '∙', '·', '√', 'ⁿ', '²', '■', ' ',
];

/** Decode a buffer as CP437. Every byte maps to exactly one character. */
export function decodeCp437(buf: Buffer): string {
  let out = '';
  for (const byte of buf) {
    out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
  }
  return out;
}

/**
 * Whether the bytes are well-formed UTF-8.
 *
 * Node's UTF-8 decoder is lossy — it substitutes U+FFFD rather than failing — so
 * "did this decode?" has to be answered by walking the byte structure. A file
 * that decodes clean is UTF-8; one that does not is some single-byte code page,
 * and the only question left is which.
 */
export function isValidUtf8(buf: Buffer): boolean {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b < 0x80) { i += 1; continue; }
    let extra: number;
    let min: number;
    let cp: number;
    if (b >= 0xc2 && b <= 0xdf) { extra = 1; min = 0x80; cp = b & 0x1f; }
    else if (b >= 0xe0 && b <= 0xef) { extra = 2; min = 0x800; cp = b & 0x0f; }
    else if (b >= 0xf0 && b <= 0xf4) { extra = 3; min = 0x10000; cp = b & 0x07; }
    else return false; // 0x80–0xC1 and 0xF5+ never start a sequence
    /*
     * A truncated final sequence is not a failure: the caller reads a fixed-size
     * window out of a larger file, so the last character is routinely cut in
     * half. Judging the whole file by that would flip every large UTF-8 file to
     * CP437 depending on where the window happened to land.
     */
    if (i + extra >= buf.length) return true;
    for (let k = 1; k <= extra; k += 1) {
      const c = buf[i + k];
      if (c < 0x80 || c > 0xbf) return false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min) return false;                        // overlong encoding
    if (cp >= 0xd800 && cp <= 0xdfff) return false;    // lone surrogate
    if (cp > 0x10ffff) return false;
    i += extra + 1;
  }
  return true;
}

/**
 * Which encoding these bytes most likely are.
 *
 * Order matters. A BOM is definitive and settles it outright. Otherwise pure
 * ASCII and valid UTF-8 are both safely read as UTF-8. What remains is a
 * single-byte code page, and the tie-break is what the high bytes are *used
 * for*: CP437 art is dense with the 0xB0–0xDF box-drawing block, whereas Latin-1
 * text uses the accented-letter range and only sparsely. `.nfo` leans to CP437
 * on a tie because that is what the format is.
 */
export function detectEncoding(buf: Buffer, extension = ''): PreviewTextEncoding {
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
    if (buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (isValidUtf8(buf)) return 'utf-8';

  let boxDrawing = 0;
  let high = 0;
  for (const b of buf) {
    if (b < 0x80) continue;
    high += 1;
    if (b >= 0xb0 && b <= 0xdf) boxDrawing += 1;
  }
  if (high === 0) return 'utf-8';
  const artRatio = boxDrawing / high;
  if (artRatio >= 0.5) return 'cp437';
  const isNfo = extension === 'nfo' || extension === 'diz';
  return isNfo && artRatio >= 0.25 ? 'cp437' : 'latin1';
}

/** Strip a leading byte-order mark, which is metadata and not content. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Decode with a specific encoding. No detection, no fallbacks. */
export function decodeWith(buf: Buffer, encoding: PreviewTextEncoding): string {
  switch (encoding) {
    case 'cp437':
      return decodeCp437(buf);
    case 'latin1':
      return stripBom(buf.toString('latin1'));
    case 'utf-16le':
      return stripBom(buf.toString('utf16le'));
    case 'utf-16be':
      // Node has no utf16be decoder — swap the pairs and reuse the LE one.
      return stripBom(Buffer.from(buf).swap16().toString('utf16le'));
    case 'utf-8':
    default:
      return stripBom(buf.toString('utf8'));
  }
}

/**
 * Decode text, honouring a caller-chosen encoding and reporting what was
 * detected regardless — the viewer offers the choice, so it has to show both
 * what it used and what the file looked like.
 */
export function decodeText(
  buf: Buffer,
  extension = '',
  requested?: PreviewTextEncoding | null,
): { content: string; encoding: PreviewTextEncoding; detected: PreviewTextEncoding } {
  const detected = detectEncoding(buf, extension);
  const encoding = requested ?? detected;
  return { content: decodeWith(buf, encoding), encoding, detected };
}

/**
 * Does this look like text at all?
 *
 * A NUL byte in the first few KB is the classic binary tell — no text encoding
 * this decoder handles produces one in normal prose (UTF-16 does, which is why
 * a BOM short-circuits the check before it runs).
 */
export function looksBinary(buf: Buffer): boolean {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    return false;
  }
  const window = buf.subarray(0, 8192);
  return window.includes(0);
}
