import { toActivityItem, AuditRow } from './dashboard.module';

const at = new Date('2026-07-09T12:00:00.000Z');

function row(over: Partial<AuditRow>): AuditRow {
  return {
    id: 'a1',
    action: 'x',
    objectType: null,
    result: 'success',
    metadata: null,
    createdAt: at,
    user: null,
    ...over,
  };
}

describe('dashboard activity — toActivityItem', () => {
  it('renders a media rename with the show name and a from → to detail', () => {
    const item = toActivityItem(
      row({
        action: 'media.rename',
        objectType: 'torrent',
        metadata: {
          applied: 1,
          skipped: 0,
          failed: 0,
          deleted: 0,
          mode: 'rename_in_place',
          name: '9-1-1 (2018)',
          from: '911.S08E01.mkv',
          to: '9-1-1 (2018) - S08E01.mkv',
        },
      }),
    );
    expect(item.message).toBe('Renamed media for 9-1-1 (2018)');
    expect(item.detail).toBe('911.S08E01.mkv → 9-1-1 (2018) - S08E01.mkv');
    expect(item.level).toBe('info');
  });

  it('falls back to counts when a rename has no single from → to', () => {
    const item = toActivityItem(
      row({
        action: 'media.rename',
        metadata: { applied: 3, skipped: 1, failed: 0, deleted: 2 },
      }),
    );
    expect(item.message).toBe('Renamed media');
    expect(item.detail).toBe('3 applied · 1 skipped · 2 deleted');
  });

  it('marks a failed rename as an error with the show name', () => {
    const item = toActivityItem(
      row({
        action: 'media.rename',
        result: 'failure',
        metadata: { failed: 1, name: 'Tracker (2024)' },
      }),
    );
    expect(item.message).toBe('Rename failed for Tracker (2024)');
    expect(item.level).toBe('error');
  });

  it('names the release for a Smart Download execution', () => {
    const item = toActivityItem(
      row({
        action: 'media_acquisition.download.executed',
        metadata: { torrentHash: 'abc', releaseName: 'Dune.Part.Two.2024.2160p' },
      }),
    );
    expect(item.message).toBe('Downloaded Dune.Part.Two.2024.2160p');
  });

  it('surfaces the error on a failed download', () => {
    const item = toActivityItem(
      row({
        action: 'media_acquisition.download.failed',
        result: 'failure',
        metadata: { releaseName: 'Some.Release', error: 'no download URL' },
      }),
    );
    expect(item.message).toBe('Download failed for Some.Release');
    expect(item.detail).toBe('no download URL');
    expect(item.level).toBe('error');
  });

  it('still humanizes generic events with objectType-prefixed bare verbs', () => {
    const item = toActivityItem(
      row({ action: 'added', objectType: 'torrent', user: { username: 'dennis' } }),
    );
    expect(item.message).toBe('Torrent added · dennis');
    expect(item.detail).toBeNull();
  });
});
