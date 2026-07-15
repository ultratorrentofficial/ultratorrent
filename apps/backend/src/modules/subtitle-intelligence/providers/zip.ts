/**
 * A tiny, dependency-free ZIP reader — enough to pull the subtitle out of the
 * single-file archives providers like SubDL serve. Pure Node (`zlib`), no
 * third-party lib and no `unzip` binary, matching the platform's keep-it-lean,
 * degrade-gracefully philosophy.
 *
 * It reads the End Of Central Directory record, then the first central-directory
 * entry (which carries the authoritative compressed size and local-header
 * offset — more reliable than the local header, whose size fields are 0 in
 * streaming/data-descriptor zips), and inflates that one entry. Stored (method 0)
 * and Deflate (method 8) are handled; anything else returns null.
 */
import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50; // End Of Central Directory
const SIG_CDH = 0x02014b50; // Central Directory Header
const SIG_LFH = 0x04034b50; // Local File Header

export interface ZipEntry {
  name: string;
  content: Buffer;
}

/** Extract the first file from a ZIP buffer, or null if it can't be read. Pure. */
export function unzipFirstEntry(buf: Buffer): ZipEntry | null {
  if (buf.length < 22) return null;

  // Find the EOCD by scanning backwards over the (up to 64 KiB) trailing comment.
  let eocd = -1;
  const minStart = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== SIG_CDH) return null;

  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const nameLen = buf.readUInt16LE(cdOffset + 28);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);

  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== SIG_LFH) return null;
  const lhNameLen = buf.readUInt16LE(localOffset + 26);
  const lhExtraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
  const data = buf.subarray(dataStart, dataStart + compSize);

  try {
    if (method === 0) return { name, content: Buffer.from(data) };
    if (method === 8) return { name, content: inflateRawSync(data) };
    return null; // unsupported compression
  } catch {
    return null;
  }
}

/** True when a buffer looks like a ZIP archive (local file header magic). Pure. */
export function looksLikeZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === SIG_LFH;
}
