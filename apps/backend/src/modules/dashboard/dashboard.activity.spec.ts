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

  it('credits the actor by full name when the account has one', () => {
    const item = toActivityItem(
      row({ action: 'added', objectType: 'torrent', user: { username: 'dayala', displayName: 'Dennis Ayala' } }),
    );
    expect(item.message).toBe('Torrent added · Dennis Ayala');
  });

  it('names the show a missing-episode grab was for', () => {
    const item = toActivityItem(
      row({
        action: 'media_acquisition.missing_episode.grabbed',
        metadata: { releaseTitle: 'Beyond the Gates S02E148 1080p', via: 'rss_rule' },
      }),
    );
    expect(item.message).toBe('Grabbed missing episode: Beyond the Gates S02E148 1080p');
    expect(item.detail).toBe('via rss_rule');
  });

  it('names the release an evaluation decided on, with the decision', () => {
    const item = toActivityItem(
      row({
        action: 'media_acquisition.evaluation.created',
        metadata: { decision: 'download', releaseName: 'Silo S02E01 2160p', reason: 'meets quality profile' },
      }),
    );
    expect(item.message).toBe('Evaluated Silo S02E01 2160p — download');
    expect(item.detail).toBe('meets quality profile');
  });

  it('prefers the resolved media title over the path in the metadata', () => {
    // NFO writes record their output path; the title is the readable form of it.
    const item = toActivityItem(
      row({
        action: 'media.nfo.generate',
        objectType: 'media_item',
        objectId: 'i1',
        metadata: { path: '/downloads/TV Shows/Beyond the Gates/Season 2/x.nfo', type: 'episode' },
      }),
      new Map([['i1', 'Beyond the Gates S02E122']]),
    );
    expect(item.message).toBe('Wrote NFO: Beyond the Gates S02E122');
  });

  it('names the integration a refresh was for', () => {
    const item = toActivityItem(row({ action: 'media.integration.refresh', metadata: { kind: 'plex' } }));
    expect(item.message).toBe('Refreshed Plex');
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
    expect(artwork.message).toBe('Imported artwork');
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

  it('names the media a collapsed sweep covered, then "+N more"', () => {
    const names = new Map([
      ['i1', 'Beyond the Gates S02E122'],
      ['i2', 'Carolina Caroline (2026)'],
      ['i3', 'Silo S02E01'],
      ['i4', 'Ted Lasso S03E12'],
    ]);
    const rows = ['i1', 'i2', 'i3', 'i4'].map((id, i) =>
      row({ id: `art-${i}`, action: 'media.artwork.import', objectType: 'media_item', objectId: id }),
    );
    const items = collapseActivity(rows, 15, names);
    expect(items).toHaveLength(1);
    expect(items[0].message).toBe(
      'Imported artwork: Beyond the Gates S02E122, Carolina Caroline (2026) +2 more',
    );
    expect(items[0].detail).toBe('4 events');
  });

  it('does not repeat a name when a sweep touches one item several times', () => {
    const names = new Map([['i1', 'Beyond the Gates S02E122']]);
    const rows = [0, 1, 2].map((i) =>
      row({ id: `nfo-${i}`, action: 'media.nfo.generate', objectType: 'media_item', objectId: 'i1' }),
    );
    const items = collapseActivity(rows, 15, names);
    expect(items[0].message).toBe('Wrote NFO: Beyond the Gates S02E122'); // no "+2 more"
    expect(items[0].detail).toBe('3 events');
  });

  it('falls back to the bare verb when the media is gone', () => {
    // A purged item resolves to nothing — the line still has to render.
    const rows = [0, 1].map((i) =>
      row({ id: `m-${i}`, action: 'media.metadata.fetch', objectType: 'media_item', objectId: 'gone' }),
    );
    const items = collapseActivity(rows, 15, new Map());
    expect(items[0].message).toBe('Fetched metadata');
    expect(items[0].detail).toBe('2 events');
  });

  it('carries the individual events behind a collapsed line', () => {
    // The summary names two of them; opening it has to account for all four.
    const names = new Map([
      ['i1', 'Beyond the Gates S02E122'],
      ['i2', 'Silo S02E01'],
      ['i3', 'Ted Lasso S03E12'],
      ['i4', 'Carolina Caroline (2026)'],
    ]);
    const rows = ['i1', 'i2', 'i3', 'i4'].map((id, i) =>
      row({ id: `art-${i}`, action: 'media.artwork.import', objectType: 'media_item', objectId: id }),
    );
    const [line] = collapseActivity(rows, 15, names);
    expect(line.detail).toBe('4 events');
    expect(line.events).toHaveLength(4); // the count and the contents agree
    expect(line.events!.map((e) => e.message)).toEqual([
      'Imported artwork: Beyond the Gates S02E122',
      'Imported artwork: Silo S02E01',
      'Imported artwork: Ted Lasso S03E12',
      'Imported artwork: Carolina Caroline (2026)',
    ]);
    expect(line.events!.every((e) => e.events === null)).toBe(true); // one level deep
  });

  it('leaves a single event with nothing to expand', () => {
    const items = collapseActivity([row({ id: 's1', action: 'media.integration.refresh' })], 15);
    expect(items[0].events).toBeNull();
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
