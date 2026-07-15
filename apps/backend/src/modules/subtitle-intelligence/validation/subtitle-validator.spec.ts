import { detectFormat, validateSubtitle } from './subtitle-validator';

const SRT = `1
00:00:01,000 --> 00:00:04,000
Hello world.

2
00:00:05,000 --> 00:00:08,500
Second line.
`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world.
`;

const ASS = `[Script Info]
Title: x
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hello world.
`;

describe('detectFormat', () => {
  it('recognizes each format from content', () => {
    expect(detectFormat(SRT)).toBe('srt');
    expect(detectFormat(VTT)).toBe('vtt');
    expect(detectFormat(ASS)).toBe('ass');
    expect(detectFormat('not a subtitle')).toBe('unknown');
  });
});

describe('validateSubtitle', () => {
  it('accepts a well-formed SRT', () => {
    const r = validateSubtitle(SRT);
    expect(r.valid).toBe(true);
    expect(r.format).toBe('srt');
    expect(r.cueCount).toBe(2);
    expect(r.startMs).toBe(1000);
    expect(r.endMs).toBe(8500);
    expect(r.issues).toHaveLength(0);
  });

  it('accepts WebVTT and ASS', () => {
    expect(validateSubtitle(VTT).valid).toBe(true);
    expect(validateSubtitle(ASS).valid).toBe(true);
    expect(validateSubtitle(ASS).format).toBe('ass');
  });

  it('rejects an empty file', () => {
    const r = validateSubtitle('   ');
    expect(r.valid).toBe(false);
    expect(r.issues[0].code).toBe('empty');
  });

  it('rejects unrecognizable content', () => {
    const r = validateSubtitle('just some prose with no cues');
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'unknown_format')).toBe(true);
  });

  it('flags an inverted cue (end <= start)', () => {
    const bad = `1\n00:00:05,000 --> 00:00:02,000\nOops.\n`;
    const r = validateSubtitle(bad);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'inverted_timing')).toBe(true);
  });

  it('flags out-of-order cues as an error', () => {
    const bad = `1\n00:00:10,000 --> 00:00:12,000\nA\n\n2\n00:00:01,000 --> 00:00:02,000\nB\n`;
    const r = validateSubtitle(bad);
    expect(r.valid).toBe(false);
    expect(r.issues.some((i) => i.code === 'out_of_order')).toBe(true);
  });

  it('treats overlap as a non-fatal warning', () => {
    const overlap = `1\n00:00:01,000 --> 00:00:06,000\nA\n\n2\n00:00:04,000 --> 00:00:08,000\nB\n`;
    const r = validateSubtitle(overlap);
    expect(r.valid).toBe(true);
    expect(r.issues.some((i) => i.code === 'overlap' && i.severity === 'warning')).toBe(true);
  });

  it('flags a large gap as a warning', () => {
    const gap = `1\n00:00:01,000 --> 00:00:02,000\nA\n\n2\n00:10:00,000 --> 00:10:02,000\nB\n`;
    const r = validateSubtitle(gap);
    expect(r.valid).toBe(true);
    expect(r.issues.some((i) => i.code === 'large_gap')).toBe(true);
  });
});
