import { RssService } from './rss.module';

/**
 * Where the info-hash comes from.
 *
 * `hashAlreadyDownloaded` is the guard that stops a release being grabbed twice,
 * and it matches `WHERE infoHash = <value>`. A NULL is invisible to it, so a row
 * without a hash is a title that can silently re-download — nothing reports a
 * duplicate that was never detected.
 *
 * Live on ehr-qnap: 96 of 351 downloaded rows had no hash, and "Backrooms (2026)"
 * came back 18 days later. Its feed item had no magnet at all — but its link was
 * `https://yts.gg/torrent/download/18BADF35B462…`, with the hash right there.
 */
const extract = (magnet: string | null, link?: string | null) =>
  (RssService.prototype as never as {
    extractInfoHash(m: string | null, l?: string | null): string | null;
  }).extractInfoHash(magnet, link);

describe('RssService.extractInfoHash', () => {
  it('reads a magnet, lowercased', () => {
    expect(extract('magnet:?xt=urn:btih:ABCDEF1234567890&dn=x')).toBe('abcdef1234567890');
  });

  it('reads the hash out of a .torrent LINK when there is no magnet', () => {
    // The Backrooms case, verbatim.
    expect(extract(null, 'https://yts.gg/torrent/download/18BADF35B4622F33E1BDBBCF8C323CE28A6DD5AB'))
      .toBe('18badf35b4622f33e1bdbbcf8c323ce28a6dd5ab');
  });

  it('prefers the magnet when both are present', () => {
    // The magnet states the hash; a link merely tends to contain one.
    expect(extract('magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      'https://x/download/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'))
      .toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('ignores a hex run that is not 40 characters', () => {
    // An id or tracking parameter that happens to be hexadecimal is not a hash,
    // and treating one as a hash would dedup two unrelated releases together.
    expect(extract(null, 'https://x/download/deadbeef')).toBeNull();
    expect(extract(null, 'https://x/d/' + 'a'.repeat(39))).toBeNull();
    expect(extract(null, 'https://x/d/' + 'a'.repeat(41))).toBeNull();
  });

  it('finds a hash bounded by path separators or query syntax', () => {
    const h = 'c'.repeat(40);
    expect(extract(null, `https://x/${h}/file.torrent`)).toBe(h);
    expect(extract(null, `https://x/get?hash=${h}&tk=1`)).toBe(h);
  });

  it('returns null when there is nothing to read', () => {
    expect(extract(null)).toBeNull();
    expect(extract(null, 'https://x/download/some-slug-name')).toBeNull();
    expect(extract(null, null)).toBeNull();
  });
});
