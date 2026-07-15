import { deflateRawSync } from 'node:zlib';
import { looksLikeZip, unzipFirstEntry } from './zip';

/** Build a minimal one-entry ZIP (stored or deflate) for the extractor to read. */
function makeZip(name: string, content: Buffer, method: 0 | 8): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const data = method === 8 ? deflateRawSync(content) : content;

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(method, 8);
  lfh.writeUInt32LE(data.length, 18);
  lfh.writeUInt32LE(content.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  const local = Buffer.concat([lfh, nameBuf, data]);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(method, 10);
  cdh.writeUInt32LE(data.length, 20);
  cdh.writeUInt32LE(content.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42); // local header offset
  const cd = Buffer.concat([cdh, nameBuf]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(local.length, 16);

  return Buffer.concat([local, cd, eocd]);
}

describe('unzipFirstEntry', () => {
  const body = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello.\n');

  it('extracts a stored (uncompressed) entry', () => {
    const entry = unzipFirstEntry(makeZip('movie.en.srt', body, 0));
    expect(entry?.name).toBe('movie.en.srt');
    expect(entry?.content.toString('utf8')).toBe(body.toString('utf8'));
  });

  it('extracts a deflated entry', () => {
    const entry = unzipFirstEntry(makeZip('movie.en.srt', body, 8));
    expect(entry?.content.toString('utf8')).toBe(body.toString('utf8'));
  });

  it('returns null for a non-zip buffer', () => {
    expect(unzipFirstEntry(Buffer.from('not a zip'))).toBeNull();
  });
});

describe('looksLikeZip', () => {
  it('recognizes the local-file-header magic', () => {
    expect(looksLikeZip(makeZip('x.srt', Buffer.from('a'), 0))).toBe(true);
    expect(looksLikeZip(Buffer.from('WEBVTT'))).toBe(false);
  });
});
