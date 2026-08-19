import { decodeCp437, decodeText, detectEncoding, isValidUtf8, looksBinary } from './preview-text';

describe('isValidUtf8', () => {
  it('accepts ASCII and well-formed multi-byte sequences', () => {
    expect(isValidUtf8(Buffer.from('plain ascii'))).toBe(true);
    expect(isValidUtf8(Buffer.from('café — ñandú 日本語', 'utf8'))).toBe(true);
  });

  it('rejects lone continuation bytes, overlongs and surrogates', () => {
    expect(isValidUtf8(Buffer.from([0x41, 0x80, 0x42]))).toBe(false);
    expect(isValidUtf8(Buffer.from([0xc0, 0xaf]))).toBe(false);          // overlong '/'
    expect(isValidUtf8(Buffer.from([0xed, 0xa0, 0x80]))).toBe(false);    // U+D800
  });

  /*
   * The preview reads a fixed window out of a larger file, so the last character
   * is routinely cut in half. Treating that as invalid would flip large UTF-8
   * files to CP437 purely on where the window landed.
   */
  it('tolerates a sequence truncated by the read window', () => {
    const cut = Buffer.from('日本語', 'utf8').subarray(0, 7); // last char clipped
    expect(isValidUtf8(cut)).toBe(true);
  });
});

describe('decodeCp437', () => {
  it('maps the box-drawing range that scene art is built from', () => {
    expect(decodeCp437(Buffer.from([0xc9, 0xcd, 0xbb]))).toBe('╔═╗');
    expect(decodeCp437(Buffer.from([0xdb, 0xb0]))).toBe('█░');
  });

  it('leaves the ASCII half untouched', () => {
    expect(decodeCp437(Buffer.from('RELEASE.NFO'))).toBe('RELEASE.NFO');
  });
});

describe('detectEncoding', () => {
  it('honours a BOM over any heuristic', () => {
    expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe('utf-16le');
    expect(detectEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x41]))).toBe('utf-16be');
    expect(detectEncoding(Buffer.from('﻿hi', 'utf8'))).toBe('utf-8');
  });

  it('reads valid UTF-8 as UTF-8', () => {
    expect(detectEncoding(Buffer.from('subtítulos en español', 'utf8'))).toBe('utf-8');
  });

  it('calls dense box-drawing CP437 whatever the extension', () => {
    const art = Buffer.from([0xc9, ...Array(40).fill(0xcd), 0xbb, 0x0a]);
    expect(detectEncoding(art, 'txt')).toBe('cp437');
  });

  /*
   * The distinguishing question is what the high bytes are USED for. Accented
   * letters in prose are Latin-1; the same file named `.nfo` is not enough to
   * override that, but a lighter dusting of art in an NFO is.
   */
  it('reads sparse accented high bytes as Latin-1', () => {
    const latin = Buffer.from([...Buffer.from('El ni'), 0xf1, ...Buffer.from('o cant'), 0xf3]);
    expect(detectEncoding(latin, 'srt')).toBe('latin1');
  });

  it('leans CP437 for an .nfo with partial art', () => {
    // A third of the high bytes are art — under the ratio that settles it
    // outright, and enough that an `.nfo` should still be read as CP437.
    const mixed = Buffer.from([
      ...Buffer.from('GROUP PRESENTS '),
      0xdb, 0xb0, 0xc4,
      ...Buffer.from(' rip by '),
      0xe9, 0xe0, 0xf1, 0xf3, 0xfa, 0xed,
    ]);
    expect(detectEncoding(mixed, 'nfo')).toBe('cp437');
    expect(detectEncoding(mixed, 'txt')).toBe('latin1');
  });
});

describe('decodeText', () => {
  it('reports the detected encoding even when the caller overrides it', () => {
    const art = Buffer.from([0xc9, 0xcd, 0xbb]);
    const forced = decodeText(art, 'nfo', 'latin1');
    expect(forced.encoding).toBe('latin1');
    expect(forced.detected).toBe('cp437');
    expect(forced.content).not.toBe('╔═╗');
  });

  it('strips a BOM, which is metadata and not content', () => {
    expect(decodeText(Buffer.from('﻿hello', 'utf8')).content).toBe('hello');
  });

  it('decodes UTF-16BE by swapping into the LE decoder', () => {
    const be = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]);
    expect(decodeText(be).content).toBe('hi');
  });
});

describe('looksBinary', () => {
  it('flags a NUL byte in the leading window', () => {
    expect(looksBinary(Buffer.from([0x4d, 0x5a, 0x00, 0x01]))).toBe(true);
  });

  it('does not flag UTF-16, whose NULs are structural', () => {
    expect(looksBinary(Buffer.from([0xff, 0xfe, 0x41, 0x00]))).toBe(false);
  });

  it('passes ordinary text', () => {
    expect(looksBinary(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello\n'))).toBe(false);
  });
});
