import { infoHashFromMagnet, magnetRejectionReason } from './magnet';

/**
 * Reading a magnet URI.
 *
 * Live, pasting a magnet into Add Torrent returned `500 Internal server error`
 * with nothing else — the provider threw a bare `Error` from inside `addMagnet`.
 * Two separate faults produced that: the parser was narrower than the URIs
 * people actually paste, and a bad input was reported as a server fault.
 *
 * The parser also existed twice, once per engine provider, both copies matching
 * case-sensitively — while the RSS reader and Torznab client parsing the same
 * URIs both matched case-insensitively. One implementation now, and these pin
 * what it accepts.
 */
const HEX = '44f0ab56d69f5eb9910dd5501b2b548c395fe813';

describe('infoHashFromMagnet', () => {
  it('reads a v1 hex info-hash', () => {
    expect(infoHashFromMagnet(`magnet:?xt=urn:btih:${HEX}&dn=X`)).toBe(HEX);
  });

  it('reads it whatever the case — a urn is case-insensitive', () => {
    // Real sites emit this, and the old regex had no `i` flag, so it was a 500.
    expect(infoHashFromMagnet(`magnet:?XT=URN:BTIH:${HEX.toUpperCase()}&dn=X`)).toBe(HEX);
  });

  it('reads it through percent-encoding', () => {
    // How a magnet arrives when copied out of a redirect or a wrapped link.
    expect(infoHashFromMagnet(`magnet:?xt=urn%3Abtih%3A${HEX}`)).toBe(HEX);
  });

  it('reads a base32 info-hash', () => {
    const b32 = 'ITYKWVWWSX2G5OI3LVIBWG2UQOBZP2AT';
    const out = infoHashFromMagnet(`magnet:?xt=urn:btih:${b32}`);
    expect(out).toMatch(/^[0-9a-f]{40}$/);
  });

  it('prefers the v1 hash on a hybrid v1+v2 magnet', () => {
    // v1 is the id every engine and every table here already keys on.
    const v2 = '1220'.concat('c'.repeat(64));
    expect(infoHashFromMagnet(`magnet:?xt=urn:btmh:${v2}&xt=urn:btih:${HEX}`)).toBe(HEX);
  });

  it('reads a v2-only magnet as the truncated v2 hash', () => {
    const sha256 = 'caf1e1c30e81cb361b9ee167c4aa64228a7fa4fa9f6105232b28ad099f3a302e';
    // Truncated to 20 bytes — the form an engine reports back, so the
    // load-confirmation can actually match it.
    expect(infoHashFromMagnet(`magnet:?xt=urn:btmh:1220${sha256}`)).toBe(sha256.slice(0, 40));
  });

  it('returns null for an info-hash of the wrong size', () => {
    expect(infoHashFromMagnet('magnet:?xt=urn:btih:deadbeef')).toBeNull();
  });

  it('returns null when there is no info-hash at all', () => {
    expect(infoHashFromMagnet('magnet:?dn=Just+A+Name')).toBeNull();
  });
});

describe('magnetRejectionReason', () => {
  it('passes a readable magnet', () => {
    expect(magnetRejectionReason(`magnet:?xt=urn:btih:${HEX}`)).toBeNull();
  });

  it('points a non-magnet at the URL field instead', () => {
    const reason = magnetRejectionReason('https://example.org/x.torrent');
    expect(reason).toMatch(/not a magnet link/i);
    expect(reason).toMatch(/URL field/i);
  });

  it('says so when the hash is the wrong shape', () => {
    expect(magnetRejectionReason('magnet:?xt=urn:btih:deadbeef')).toMatch(/malformed/i);
  });

  it('says so when there is no hash parameter', () => {
    expect(magnetRejectionReason('magnet:?dn=X')).toMatch(/no info-hash/i);
  });

  it('rejects an empty string rather than reporting it as fine', () => {
    expect(magnetRejectionReason('   ')).toMatch(/empty/i);
  });
});
