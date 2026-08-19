import { describe, expect, it } from 'vitest';
import {
  clockToMs,
  detectSubtitleFormat,
  matchSubtitlesFor,
  msToShortClock,
  parseSubtitles,
  stripCueMarkup,
  subtitleLanguageTag,
  toVtt,
} from './subtitles';

const SRT = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  'Hello there.',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  '<i>General</i> Kenobi!',
  'Second line.',
  '',
].join('\n');

describe('clockToMs', () => {
  it('reads SRT and VTT separators alike', () => {
    expect(clockToMs('00:00:01,500')).toBe(1500);
    expect(clockToMs('00:00:01.500')).toBe(1500);
  });

  /* ASS writes hundredths; `.5` is half a second, not five milliseconds. */
  it('pads a short fraction on the right', () => {
    expect(clockToMs('0:00:01.5')).toBe(1500);
    expect(clockToMs('0:00:01.05')).toBe(1050);
  });

  it('accepts an hourless VTT stamp', () => {
    expect(clockToMs('02:30.250')).toBe(150_250);
  });

  it('returns NaN for nonsense', () => {
    expect(Number.isNaN(clockToMs('later'))).toBe(true);
  });
});

describe('detectSubtitleFormat', () => {
  it('identifies each format from its contents, not its name', () => {
    expect(detectSubtitleFormat(SRT)).toBe('srt');
    expect(detectSubtitleFormat('WEBVTT\n\n00:01.000 --> 00:02.000\nhi')).toBe('vtt');
    expect(detectSubtitleFormat('[Script Info]\nTitle: x\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,hi')).toBe('ass');
    expect(detectSubtitleFormat('just some prose')).toBe('unknown');
  });
});

describe('parseSubtitles', () => {
  it('reads SRT cues and renumbers them by position', () => {
    const { format, cues } = parseSubtitles(SRT);
    expect(format).toBe('srt');
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ index: 1, startMs: 1000, endMs: 3500, text: 'Hello there.' });
    expect(cues[1].text).toBe('General Kenobi!\nSecond line.');
  });

  it('survives CRLF line endings', () => {
    expect(parseSubtitles(SRT.replace(/\n/g, '\r\n')).cues).toHaveLength(2);
  });

  it('skips the WEBVTT header and NOTE blocks', () => {
    const vtt = 'WEBVTT\n\nNOTE this is a comment\n\n00:00:01.000 --> 00:00:02.000\nOnly cue\n';
    const { cues } = parseSubtitles(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Only cue');
  });

  it('reads ASS dialogue with the field order the file declares', () => {
    const ass = [
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8}Up top, with a comma',
    ].join('\n');
    const { format, cues } = parseSubtitles(ass);
    expect(format).toBe('ass');
    expect(cues[0]).toMatchObject({ startMs: 1000, endMs: 2500, text: 'Up top, with a comma' });
  });

  it('reports overlaps, backwards timings and empty cues rather than fixing them', () => {
    const bad = [
      '1', '00:00:05,000 --> 00:00:10,000', 'first', '',
      '2', '00:00:08,000 --> 00:00:09,000', '', '',
      '3', '00:00:20,000 --> 00:00:19,000', 'third', '',
    ].join('\n');
    const { warnings } = parseSubtitles(bad);
    expect(warnings.join(' | ')).toMatch(/1 cue with no text/);
    expect(warnings.join(' | ')).toMatch(/1 cue end before/);
    expect(warnings.join(' | ')).toMatch(/1 overlapping cue/);
  });

  it('says so when nothing could be read', () => {
    expect(parseSubtitles('not a subtitle at all').warnings).toContain('No cues could be read from this file');
  });
});

describe('stripCueMarkup', () => {
  it('removes ASS override blocks and HTML-ish tags', () => {
    expect(stripCueMarkup('{\\pos(10,20)}<font color="red">Red</font>')).toBe('Red');
  });

  it('turns literal escapes into real line breaks', () => {
    expect(stripCueMarkup('one\\Ntwo')).toBe('one\ntwo');
  });
});

describe('toVtt', () => {
  it('emits a WEBVTT header and dot-separated stamps', () => {
    const out = toVtt(parseSubtitles(SRT));
    expect(out.startsWith('WEBVTT\n\n')).toBe(true);
    expect(out).toContain('00:00:01.000 --> 00:00:03.500');
  });

  /* A cue with no text or no duration renders as nothing; leaving it in makes
   * the track malformed rather than empty. */
  it('drops cues a player could not show', () => {
    const parsed = parseSubtitles(['1', '00:00:01,000 --> 00:00:01,000', '', '', '2', '00:00:02,000 --> 00:00:03,000', 'ok', ''].join('\n'));
    expect(toVtt(parsed).match(/-->/g)).toHaveLength(1);
  });
});

describe('matchSubtitlesFor', () => {
  const siblings = [
    'Film.2019.1080p.mkv',
    'Film.2019.1080p.en.srt',
    'Film.2019.1080p.srt',
    'Film.2019.1080p.pt-BR.ass',
    'Some.Other.Film.srt',
    'Film.2019.1080p.nfo',
  ];

  it('takes the subtitles that share the stem and nothing else in the folder', () => {
    expect(matchSubtitlesFor('Film.2019.1080p.mkv', siblings)).toEqual([
      'Film.2019.1080p.en.srt',
      'Film.2019.1080p.srt',
      'Film.2019.1080p.pt-BR.ass',
    ]);
  });
});

describe('subtitleLanguageTag', () => {
  it('reads the language tag when the name carries one', () => {
    expect(subtitleLanguageTag('Film.en.srt')).toBe('en');
    expect(subtitleLanguageTag('Film.pt-BR.srt')).toBe('pt-BR');
    expect(subtitleLanguageTag('Film.spanish.srt')).toBe('spanish');
  });

  it('claims nothing for an unlabelled file or a flag', () => {
    expect(subtitleLanguageTag('Film.srt')).toBeNull();
    expect(subtitleLanguageTag('Film.forced.srt')).toBeNull();
  });
});

describe('msToShortClock', () => {
  it('drops the hour until there is one', () => {
    expect(msToShortClock(65_000)).toBe('1:05');
    expect(msToShortClock(3_725_000)).toBe('1:02:05');
  });
});
