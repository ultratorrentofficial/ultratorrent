import { describe, it, expect } from 'vitest';
import { humanizeMetadata } from './audit';

const byLabel = (fields: ReturnType<typeof humanizeMetadata>, label: string) =>
  fields.find((f) => f.label === label);

describe('humanizeMetadata', () => {
  it('humanizes keys (camelCase / snake_case / acronyms)', () => {
    const fields = humanizeMetadata({ libraryPath: '/media', torrentHash: 'abc', imdbId: 'tt1' });
    expect(byLabel(fields, 'Library path')).toBeTruthy();
    expect(byLabel(fields, 'Torrent hash')).toBeTruthy();
    expect(byLabel(fields, 'IMDb ID')).toBeTruthy(); // acronym fixups
  });

  it('formats booleans, byte sizes and dates', () => {
    const fields = humanizeMetadata({
      enabled: true,
      pruneEmptyDirs: false,
      bytesReclaimed: 1073741824,
      checkedAt: '2026-07-10T18:14:00.000Z',
    });
    expect(byLabel(fields, 'Enabled')!.value).toBe('Yes');
    expect(byLabel(fields, 'Prune empty dirs')!.value).toBe('No');
    expect(byLabel(fields, 'Bytes reclaimed')!.value).toContain('GB'); // not a raw number
    expect(byLabel(fields, 'Checked at')!.value).not.toBe('2026-07-10T18:14:00.000Z'); // formatted
  });

  it('joins scalar arrays and marks hashes/paths monospace', () => {
    const fields = humanizeMetadata({
      actions: ['delete', 'notify'],
      hash: 'c0ed8b842715b942ea9cac6ec5fb772df953b0db',
    });
    expect(byLabel(fields, 'Actions')!.value).toBe('delete, notify');
    expect(byLabel(fields, 'Hash')!.mono).toBe(true);
  });

  it('keeps genuinely nested values as JSON (the deliberate escape hatch)', () => {
    const fields = humanizeMetadata({ diff: { added: 3 }, changes: [{ field: 'x' }] });
    expect(byLabel(fields, 'Diff')!.value).toBeNull();
    expect(byLabel(fields, 'Diff')!.json).toContain('"added": 3');
    expect(byLabel(fields, 'Changes')!.json).toContain('"field": "x"');
  });

  it('drops null/undefined/empty fields and empty arrays', () => {
    const fields = humanizeMetadata({ a: null, b: undefined, c: '', d: [], keep: 'yes' });
    expect(fields.map((f) => f.label)).toEqual(['Keep']);
  });

  it('returns [] for non-object metadata', () => {
    expect(humanizeMetadata(null)).toEqual([]);
    expect(humanizeMetadata('nope')).toEqual([]);
  });
});
