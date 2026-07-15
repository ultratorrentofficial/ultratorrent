import { applyTiming, msToAss, msToClock, shiftTimestamps } from './retime';

describe('applyTiming', () => {
  it('applies offset and drift, clamped at zero', () => {
    expect(applyTiming(1000, 500, 1)).toBe(1500);
    expect(applyTiming(1000, -2000, 1)).toBe(0); // clamped
    expect(applyTiming(1000, 0, 1.1)).toBe(1100); // drift
  });
});

describe('formatting', () => {
  it('formats SRT/VTT/ASS clocks', () => {
    expect(msToClock(3_661_500, ',')).toBe('01:01:01,500');
    expect(msToClock(3_661_500, '.')).toBe('01:01:01.500');
    expect(msToAss(3_661_500)).toBe('1:01:01.50');
  });
});

describe('shiftTimestamps', () => {
  it('shifts an SRT cue by a positive offset, preserving format', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nHello.\n';
    const out = shiftTimestamps(srt, 'srt', 2000);
    expect(out).toContain('00:00:03,000 --> 00:00:06,000');
    expect(out).toContain('Hello.'); // text untouched
  });

  it('clamps a negative offset so no cue starts before zero', () => {
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nHi.\n';
    const out = shiftTimestamps(srt, 'srt', -2000);
    expect(out).toContain('00:00:00,000 --> 00:00:02,000');
  });

  it('shifts a VTT cue keeping the dot separator', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi.\n';
    const out = shiftTimestamps(vtt, 'vtt', 500);
    expect(out).toContain('00:00:01.500 --> 00:00:02.500');
  });

  it('shifts an ASS Dialogue in centiseconds', () => {
    const ass = 'Dialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Hi.\n';
    const out = shiftTimestamps(ass, 'ass', 1000);
    expect(out).toContain('0:00:02.00,0:00:05.00');
  });

  it('applies a linear drift factor', () => {
    const srt = '1\n00:00:10,000 --> 00:00:20,000\nHi.\n';
    const out = shiftTimestamps(srt, 'srt', 0, 1.1);
    expect(out).toContain('00:00:11,000 --> 00:00:22,000');
  });
});
