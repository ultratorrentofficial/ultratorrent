/**
 * OpenSubtitles "movie hash" — the highest-confidence subtitle search key.
 *
 * It is NOT a content hash: it is a 64-bit checksum of the file size plus the
 * first and last 64 KiB, summed as little-endian unsigned 64-bit words. Cheap
 * (reads 128 KiB regardless of file size) and stable, so an exact hash match
 * means the subtitle was timed against THIS encode — the only signal that
 * guarantees perfect sync without further verification.
 *
 * Reference algorithm: https://trac.opensubtitles.org/projects/opensubtitles/wiki/HashSourceCodes
 *
 * This module is pure arithmetic over a readable stream; the IO (opening the
 * file within the hard roots) lives in the fingerprint service so this stays
 * trivially unit-testable against fixed byte buffers.
 */

/** 64 KiB — the block read from each end of the file. */
export const HASH_BLOCK_BYTES = 65536;

const MASK64 = (1n << 64n) - 1n;

/** Sum a buffer as consecutive little-endian uint64 words into `acc` (mod 2^64). */
function addUint64LE(acc: bigint, buf: Buffer): bigint {
  let sum = acc;
  // Whole 8-byte words only; OpenSubtitles' 64 KiB blocks are always a multiple.
  for (let i = 0; i + 8 <= buf.length; i += 8) {
    sum = (sum + buf.readBigUInt64LE(i)) & MASK64;
  }
  return sum;
}

/**
 * Compute the movie hash from the file size and its head/tail 64 KiB blocks.
 * Returns the canonical lower-case, zero-padded 16-hex-digit string, or null
 * when the file is too small to hash (< 128 KiB — the two blocks would overlap
 * and OpenSubtitles itself does not hash such files). Pure.
 */
export function computeMovieHash(
  fileSize: number | bigint,
  head: Buffer,
  tail: Buffer,
): string | null {
  const size = BigInt(fileSize);
  if (size < BigInt(2 * HASH_BLOCK_BYTES)) return null;
  if (head.length < HASH_BLOCK_BYTES || tail.length < HASH_BLOCK_BYTES) return null;

  let hash = size & MASK64;
  hash = addUint64LE(hash, head.subarray(0, HASH_BLOCK_BYTES));
  hash = addUint64LE(hash, tail.subarray(tail.length - HASH_BLOCK_BYTES));
  hash &= MASK64;
  return hash.toString(16).padStart(16, '0');
}
