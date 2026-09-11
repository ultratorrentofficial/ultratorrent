import { gzipSync } from 'node:zlib';
import { extractMmdb } from './geoip-downloader.service';

/** Build a single-entry tar (512-byte header + padded data). */
function tarEntry(name: string, data: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function tar(entries: Array<[string, Buffer]>): Buffer {
  return Buffer.concat([...entries.map(([n, d]) => tarEntry(n, d)), Buffer.alloc(1024)]);
}

describe('extractMmdb', () => {
  it('pulls the .mmdb member out of a MaxMind-shaped archive', () => {
    const db = Buffer.from('THIS-IS-THE-DATABASE-CONTENT');
    const archive = tar([
      ['GeoLite2-City_20260909/COPYRIGHT.txt', Buffer.from('© MaxMind')],
      ['GeoLite2-City_20260909/GeoLite2-City.mmdb', db],
      ['GeoLite2-City_20260909/LICENSE.txt', Buffer.from('license')],
    ]);
    const out = extractMmdb(archive);
    expect(out).not.toBeNull();
    expect(out!.equals(db)).toBe(true);
  });

  it('returns the exact bytes even when the db is larger than one block', () => {
    const db = Buffer.alloc(512 * 3 + 137, 7); // spans four blocks, not block-aligned
    const out = extractMmdb(tar([['x/GeoLite2-ASN.mmdb', db]]));
    expect(out!.length).toBe(db.length);
    expect(out!.equals(db)).toBe(true);
  });

  it('returns null when there is no .mmdb inside', () => {
    expect(extractMmdb(tar([['dir/README.txt', Buffer.from('nope')]]))).toBeNull();
  });

  it('does not read past a truncated archive', () => {
    const db = Buffer.from('partial');
    // Header claims 100 bytes but only a short buffer follows.
    const header = Buffer.alloc(512);
    header.write('x/GeoLite2-City.mmdb', 0);
    header.write((100).toString(8).padStart(11, '0') + '\0', 124);
    expect(extractMmdb(Buffer.concat([header, db]))).toBeNull();
  });

  it('handles a real gzip round-trip the way the downloader does', () => {
    const db = Buffer.from('MMDB');
    const gz = gzipSync(tar([['GeoLite2-City_1/GeoLite2-City.mmdb', db]]));
    // The downloader gunzips before extracting; mirror that here.
    const { gunzipSync } = require('node:zlib');
    expect(extractMmdb(gunzipSync(gz))!.equals(db)).toBe(true);
  });
});
