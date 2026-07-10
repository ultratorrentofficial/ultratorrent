import { toActivityItem, collapseActivity, AuditRow } from './dashboard.module';

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

  it('renders an automation rule run with the rule name and the torrent as detail', () => {
    const item = toActivityItem(
      row({
        action: 'automation.rule.executed',
        objectType: 'torrent',
        metadata: { rule: 'Remove torrent after download', actions: ['delete'], name: 'Criminal.Minds.S19E01.mkv' },
      }),
    );
    expect(item.message).toBe('Automation: Remove torrent after download');
    expect(item.detail).toBe('Criminal.Minds.S19E01.mkv');
  });

  it('marks a failed automation run as an error with the failure reason', () => {
    const item = toActivityItem(
      row({
        action: 'automation.rule.executed',
        result: 'failure',
        metadata: { rule: 'Remove torrent after download', error: 'Could not find info-hash' },
      }),
    );
    expect(item.message).toBe('Automation failed: Remove torrent after download');
    expect(item.detail).toBe('Could not find info-hash');
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

describe('dashboard activity — collapseActivity (bursty enrichment)', () => {
  // The real burst: metadata/artwork/imdb enrichment, interleaved per item.
  const ENRICH = ['media.artwork.import', 'media.imdb.enrichment.completed', 'media.metadata.fetch'];
  function burst(n: number): AuditRow[] {
    const rows: AuditRow[] = [];
    for (let i = 0; i < n; i++) {
      for (const action of ENRICH) {
        rows.push(row({ id: `${action}-${i}`, action, createdAt: new Date(at.getTime() - i * 1000) }));
      }
    }
    return rows;
  }

  it('collapses each interleaved system burst into one line with a count', () => {
    const items = collapseActivity(burst(16), 15);
    // 48 interleaved rows → 3 collapsed lines.
    expect(items).toHaveLength(3);
    const artwork = items.find((i) => i.type === 'media.artwork.import')!;
    expect(artwork.message).toBe('Media artwork import');
    expect(artwork.detail).toBe('16 events');
    expect(items.map((i) => i.type)).toEqual(ENRICH); // order preserved (newest first)
  });

  it('keeps a burst from crowding out other events in the window', () => {
    const rows = [
      row({ id: 'auto', action: 'automation.rule.executed', objectType: 'torrent', metadata: { rule: 'Remove torrent after download' } }),
      ...burst(20),
      row({ id: 'login', action: 'auth.login', user: { username: 'dennis' } }),
    ];
    const items = collapseActivity(rows, 15);
    // automation + 3 collapsed enrichment groups + the login = 5 lines, not 62.
    expect(items).toHaveLength(5);
    expect(items[0].type).toBe('automation.rule.executed');
    expect(items.some((i) => i.type === 'auth.login')).toBe(true);
  });

  it('collapses repeated user-attributed events, keeping the actor', () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      row({ id: `view-${i}`, action: 'prowlarr.settings.viewed', user: { username: 'admin' } }),
    );
    const items = collapseActivity(rows, 15);
    expect(items).toHaveLength(1);
    expect(items[0].message).toBe('Prowlarr settings viewed · admin');
    expect(items[0].detail).toBe('7 events');
  });

  it('collapses automation runs per rule, keeping the rule name', () => {
    const rows = [
      ...Array.from({ length: 12 }, (_, i) =>
        row({ id: `a-${i}`, action: 'automation.rule.executed', objectType: 'torrent', metadata: { rule: 'Remove torrent after download' } }),
      ),
      ...Array.from({ length: 3 }, (_, i) =>
        row({ id: `b-${i}`, action: 'automation.rule.executed', objectType: 'torrent', metadata: { rule: 'Notify on completion' } }),
      ),
    ];
    const items = collapseActivity(rows, 15);
    expect(items).toHaveLength(2); // one line per distinct rule
    expect(items[0].message).toBe('Automation: Remove torrent after download');
    expect(items[0].detail).toBe('12 events');
    expect(items[1].message).toBe('Automation: Notify on completion');
    expect(items[1].detail).toBe('3 events');
  });

  it('never collapses renames — each names its show individually', () => {
    const rows = ['9-1-1 (2018)', 'Tracker (2024)', 'The Wire (2002)'].map((name, i) =>
      row({ id: `rn-${i}`, action: 'media.rename', metadata: { name } }),
    );
    const items = collapseActivity(rows, 15);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.detail !== '3 events')).toBe(true);
    expect(items[0].message).toBe('Renamed media for 9-1-1 (2018)');
  });

  it('does not collapse a system action that occurs only once', () => {
    const items = collapseActivity(
      [row({ id: 's1', action: 'media.integration.refresh' }), ...burst(3)],
      15,
    );
    const refresh = items.find((i) => i.type === 'media.integration.refresh')!;
    expect(refresh.detail).toBeNull(); // rendered individually, not as a burst
  });
});
