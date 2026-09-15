import { describe, it, expect, afterEach } from 'vitest';
import { setDisplayTimezone } from './format';
import { humanizeFields, prettifyKey, prettifyValue } from './humanize';

const byLabel = (fields: ReturnType<typeof humanizeFields>, label: string) =>
  fields.find((f) => f.label === label);

afterEach(() => setDisplayTimezone(null));

describe('prettifyKey', () => {
  it('turns machine keys into readable labels', () => {
    expect(prettifyKey('measuredFileCount')).toBe('Measured file count');
    expect(prettifyKey('unprobed_file_count')).toBe('Unprobed file count');
    expect(prettifyKey('library.path')).toBe('Library path');
  });

  it('keeps acronyms as acronyms', () => {
    expect(prettifyKey('imdbId')).toBe('IMDb ID');
    expect(prettifyKey('tvdbId')).toBe('TVDb ID');
    expect(prettifyKey('libraryKind')).toBe('Library kind');
  });
});

describe('prettifyValue', () => {
  it('title-cases free-form enum values', () => {
    expect(prettifyValue('matched')).toBe('Matched');
    expect(prettifyValue('not_monitored')).toBe('Not Monitored');
  });

  it('does not mangle an acronym value', () => {
    expect(prettifyValue('tv')).toBe('TV');
    expect(prettifyValue('hevc')).toBe('HEVC');
  });
});

describe('humanizeFields', () => {
  it('formats a fact section the way a person reads it', () => {
    const fields = humanizeFields({
      measuredFileCount: 62,
      posterPresent: true,
      fanartPresent: false,
      totalBytes: 1073741824,
      completionPercent: 96.4,
      totalPlaybackSeconds: 13320,
    });
    expect(byLabel(fields, 'Measured file count')!.value).toBe('62');
    expect(byLabel(fields, 'Poster present')!.value).toBe('Yes');
    expect(byLabel(fields, 'Fanart present')!.value).toBe('No');
    expect(byLabel(fields, 'Total bytes')!.value).toContain('GB');
    expect(byLabel(fields, 'Completion percent')!.value).toBe('96%');
    // A duration must never render as a bare count of seconds.
    expect(byLabel(fields, 'Total playback seconds')!.value).toBe('3h 42m');
  });

  it('groups large numbers instead of running the digits together', () => {
    const fields = humanizeFields({ fileCount: 20837 });
    expect(byLabel(fields, 'File count')!.value).toBe('20,837');
  });

  it('renders timestamps in the display timezone, with the time kept', () => {
    setDisplayTimezone('America/Puerto_Rico');
    const fields = humanizeFields({ lastScanAt: '2026-09-15T00:30:00.000Z' });
    const shown = byLabel(fields, 'Last scan at')!.value!;
    // 00:30 UTC is 20:30 the previous day in Puerto Rico: the zone must apply,
    // and the time must survive (a date-only render was the original defect).
    expect(shown).toContain('Sep 14');
    expect(shown).toMatch(/\d{2}:\d{2}/);
    expect(shown).not.toBe('2026-09-15T00:30:00.000Z');
  });

  it('omits the envelope keys the card renders itself', () => {
    const fields = humanizeFields(
      { status: 'known', source: 'media_manager', observedAt: null, fileCount: 3 },
      ['status', 'unknownReason', 'observedAt', 'source'],
    );
    expect(fields.map((f) => f.label)).toEqual(['File count']);
  });

  it('title-cases enum values by default but leaves them alone when asked', () => {
    expect(byLabel(humanizeFields({ matchStatus: 'matched' }), 'Match status')!.value).toBe('Matched');
    const verbatim = humanizeFields({ matchStatus: 'matched' }, [], false);
    expect(byLabel(verbatim, 'Match status')!.value).toBe('matched');
  });

  it('marks ids and paths monospace rather than formatting them as quantities', () => {
    const fields = humanizeFields({ storageProfileId: 42, path: '/mnt/plexmedia/TV Shows' });
    expect(byLabel(fields, 'Storage profile ID')!.value).toBe('42');
    expect(byLabel(fields, 'Storage profile ID')!.mono).toBe(true);
    expect(byLabel(fields, 'Path')!.mono).toBe(true);
  });

  it('drops empty values and keeps nested ones as JSON', () => {
    const fields = humanizeFields({ a: null, b: '', c: [], profile: { codec: 'hevc' } });
    expect(fields).toHaveLength(1);
    expect(byLabel(fields, 'Profile')!.json).toContain('"codec": "hevc"');
  });
});
