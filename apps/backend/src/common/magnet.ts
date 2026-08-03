/**
 * Read the info-hash out of a magnet URI.
 *
 * This existed twice — once in each engine provider, character for character —
 * and both copies matched `/xt=urn:btih:([a-zA-Z0-9]+)/` with no `i` flag, while
 * the RSS feed reader and the Torznab client (which parse the same URIs) both
 * used `/i`. So the same magnet could be understood by the part of the app that
 * finds it and rejected by the part that adds it.
 *
 * Everything it now accepts, and why each one showed up as a 500:
 *
 *  - **Case.** `magnet:?XT=URN:BTIH:…` is a valid URI — the `urn:` scheme and
 *    its namespace id are case-insensitive — and plenty of sites emit it that
 *    way. The old regex was case-sensitive, so it returned null.
 *  - **Percent-encoding.** A magnet copied out of a redirect or a wrapped link
 *    arrives as `xt=urn%3Abtih%3A…`. The colons never matched.
 *  - **BitTorrent v2.** A v2 magnet carries no `btih` at all, only
 *    `xt=urn:btmh:1220<sha-256>`. It was not handled in any form.
 *
 * Anything genuinely unreadable still returns null — the caller turns that into
 * a 400 naming the problem, rather than the bare 500 this used to produce.
 */

/** `1220` is the multihash prefix for sha2-256 (0x12) at 32 bytes (0x20). */
const V2_MULTIHASH_SHA256 = '1220';

/**
 * v1 info-hash: 40 hex characters, or the same 20 bytes in base32 (32 chars).
 * Any other length is not an info-hash, so it is rejected rather than passed
 * through to the engine to fail less clearly.
 */
const BTIH = /xt=urn:btih:([a-z0-9]+)/i;

/** v2 info-hash: a sha2-256 multihash, so `1220` followed by 64 hex characters. */
const BTMH = new RegExp(`xt=urn:btmh:${V2_MULTIHASH_SHA256}([0-9a-f]{64})`, 'i');

/** Decode percent-escapes when present, without throwing on a malformed one. */
function decode(input: string): string {
  if (!input.includes('%')) return input;
  try {
    return decodeURIComponent(input);
  } catch {
    return input; // a stray `%` is not a reason to stop reading the rest
  }
}

function base32ToHex(input: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/**
 * The lowercase info-hash for a magnet URI, or null when there isn't one.
 *
 * A hybrid v1+v2 magnet carries both; the v1 hash wins, because that is the id
 * every part of this application and both engines already key on.
 */
export function infoHashFromMagnet(magnet: string): string | null {
  const uri = decode(magnet);

  const v1 = BTIH.exec(uri);
  if (v1) {
    const raw = v1[1];
    if (raw.length === 40 && /^[0-9a-f]{40}$/i.test(raw)) return raw.toLowerCase();
    if (raw.length === 32) return base32ToHex(raw).toLowerCase();
    return null; // present but the wrong size — not an info-hash
  }

  const v2 = BTMH.exec(uri);
  if (v2) {
    // A v2 info-hash is 32 bytes, but everything that needs a 20-byte id — the
    // engines' own APIs included — uses it TRUNCATED to the first 20. Returning
    // the full 64 characters would produce an id no engine ever reports back,
    // so the confirmation that the torrent loaded could never match it.
    return v2[1].slice(0, 40).toLowerCase();
  }

  return null;
}

/**
 * Why a magnet could not be read, for a message the operator can act on.
 * Returns null when the magnet is fine.
 */
export function magnetRejectionReason(magnet: string): string | null {
  const trimmed = magnet.trim();
  if (!trimmed) return 'The magnet link is empty.';
  if (infoHashFromMagnet(trimmed)) return null;
  if (!/^magnet:/i.test(trimmed)) {
    return 'That is not a magnet link — it must start with "magnet:?". '
      + 'To add a .torrent by address, use the URL field instead.';
  }
  if (/xt=urn:btih:/i.test(decode(trimmed))) {
    return 'The magnet\'s info-hash is malformed — it must be 40 hexadecimal '
      + 'characters, or 32 base32 characters.';
  }
  return 'The magnet link carries no info-hash (no "xt=urn:btih:" parameter).';
}
