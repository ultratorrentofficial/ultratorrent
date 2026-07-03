import { createHash } from 'node:crypto';
import { infoHashFromTorrent } from './bencode';

describe('infoHashFromTorrent', () => {
  // Minimal single-file torrent. Byte-lengths are exact bencode strings:
  //   8:announce  10:http://t/a  4:info  <infoDict>
  const infoDict =
    'd6:lengthi12e4:name8:test.txt12:piece lengthi16384e6:pieces0:e';
  const torrent = Buffer.from(`d8:announce10:http://t/a4:info${infoDict}e`);

  it('extracts the canonical info-hash (sha1 of the raw info dict bytes)', () => {
    const hash = infoHashFromTorrent(torrent);
    const expected = createHash('sha1')
      .update(Buffer.from(infoDict))
      .digest('hex');
    expect(hash).toBe(expected);
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('changes when the info dict changes', () => {
    const otherInfo =
      'd6:lengthi99e4:name8:test.txt12:piece lengthi16384e6:pieces0:e';
    const other = Buffer.from(`d8:announce10:http://t/a4:info${otherInfo}e`);
    expect(infoHashFromTorrent(other)).not.toBe(infoHashFromTorrent(torrent));
  });

  it('rejects a string length that runs past the end of the buffer (no hang)', () => {
    // Declares a 999-byte string in a tiny buffer — must throw, not loop/allocate.
    expect(() => infoHashFromTorrent(Buffer.from('d999:xe'))).toThrow(/out of bounds/);
  });

  it('rejects a non-numeric / missing string length', () => {
    expect(() => infoHashFromTorrent(Buffer.from('dxx'))).toThrow();
  });
});
