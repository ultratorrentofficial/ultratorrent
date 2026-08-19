import { parseByteRange } from './byte-range';

describe('parseByteRange', () => {
  it('returns undefined when no range is asked for', () => {
    expect(parseByteRange(undefined, 100)).toBeUndefined();
    expect(parseByteRange('', 100)).toBeUndefined();
  });

  it('parses a closed range', () => {
    expect(parseByteRange('bytes=0-499', 1000)).toEqual({ start: 0, end: 499 });
  });

  it('runs an open-ended range to the last byte', () => {
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  /* `bytes=-500` is the LAST 500 bytes — players use it to read a trailing index. */
  it('reads the suffix form from the end of the file', () => {
    expect(parseByteRange('bytes=-500', 1000)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('clamps a stated end past EOF rather than rejecting it', () => {
    expect(parseByteRange('bytes=900-99999', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('reports a start at or past EOF as unsatisfiable', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=1200-1300', 1000)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  it('rejects a backwards range', () => {
    expect(parseByteRange('bytes=500-100', 1000)).toBe('unsatisfiable');
  });

  /*
   * A multipart or malformed header falls back to the whole file rather than a
   * 416: a client that asked badly still gets something it can play.
   */
  it('falls back to the whole file for a header it cannot parse', () => {
    expect(parseByteRange('bytes=0-99,200-299', 1000)).toBeUndefined();
    expect(parseByteRange('items=0-99', 1000)).toBeUndefined();
    expect(parseByteRange('bytes=-', 1000)).toBeUndefined();
  });
});
