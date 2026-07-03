import { createHash } from 'node:crypto';

/**
 * Minimal bencode reader used solely to compute a torrent's info-hash.
 *
 * We track byte offsets while decoding so we can SHA-1 the exact raw bytes of
 * the `info` dictionary — the canonical BitTorrent v1 info-hash.
 */
class BencodeReader {
  pos = 0;
  constructor(public readonly buf: Buffer) {}

  private byte(): number {
    return this.buf[this.pos];
  }

  decode(): unknown {
    const c = String.fromCharCode(this.byte());
    if (c === 'i') return this.readInt();
    if (c === 'l') return this.readList();
    if (c === 'd') return this.readDict();
    if (c >= '0' && c <= '9') return this.readString();
    throw new Error(`Invalid bencode at offset ${this.pos}`);
  }

  private readInt(): number {
    this.pos++; // 'i'
    const end = this.buf.indexOf('e'.charCodeAt(0), this.pos);
    const value = parseInt(this.buf.toString('ascii', this.pos, end), 10);
    this.pos = end + 1;
    return value;
  }

  private readString(): Buffer {
    const colon = this.buf.indexOf(':'.charCodeAt(0), this.pos);
    if (colon < 0) throw new Error('Invalid bencode: missing string length delimiter');
    const len = parseInt(this.buf.toString('ascii', this.pos, colon), 10);
    const start = colon + 1;
    // Bound the declared length so a malformed/hostile length can't run off the
    // end of the buffer or allocate an enormous slice.
    if (!Number.isFinite(len) || len < 0 || start + len > this.buf.length) {
      throw new Error('Invalid bencode: string length out of bounds');
    }
    this.pos = start + len;
    return this.buf.subarray(start, this.pos);
  }

  private readList(): unknown[] {
    this.pos++; // 'l'
    const out: unknown[] = [];
    while (String.fromCharCode(this.byte()) !== 'e') out.push(this.decode());
    this.pos++; // 'e'
    return out;
  }

  readDict(): Record<string, { value: unknown; start: number; end: number }> {
    this.pos++; // 'd'
    const out: Record<string, { value: unknown; start: number; end: number }> =
      {};
    while (String.fromCharCode(this.byte()) !== 'e') {
      const key = this.readString().toString('utf8');
      const start = this.pos;
      const value = this.decode();
      out[key] = { value, start, end: this.pos };
    }
    this.pos++; // 'e'
    return out;
  }
}

/** Compute the lowercase hex info-hash from raw .torrent file bytes. */
export function infoHashFromTorrent(data: Buffer): string {
  const reader = new BencodeReader(data);
  const root = reader.readDict();
  const info = root['info'];
  if (!info) throw new Error('Torrent file missing info dictionary');
  const infoBytes = data.subarray(info.start, info.end);
  return createHash('sha1').update(infoBytes).digest('hex').toLowerCase();
}
