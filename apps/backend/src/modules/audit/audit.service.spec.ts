import { AuditService } from './audit.service';

function build(rows: any[]) {
  const prisma = {
    auditLog: {
      findMany: jest.fn().mockResolvedValue(rows),
      count: jest.fn().mockResolvedValue(rows.length),
      create: jest.fn(),
    },
    wantedEpisode: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'we1', seasonNumber: 1, episodeNumber: 3, watchlistItemId: 'wl1' },
      ]),
    },
    mediaItem: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'mi1', title: 'Blindspot', year: 2015, season: 1, episode: 14 },
      ]),
    },
    mediaAcquisitionWatchlistItem: {
      findMany: jest.fn().mockResolvedValue([
        { id: 'wl1', title: 'Silo', year: 2023, seasonNumber: null, episodeNumber: null },
      ]),
    },
  };
  return { svc: new AuditService(prisma as any), prisma };
}

const row = (over: any) => ({
  id: 'a', action: 'x', objectType: null, objectId: null, result: 'success',
  metadata: null, createdAt: new Date(), user: null, ...over,
});

describe('AuditService.list — humanized media target', () => {
  it('names a wanted episode as "Show (year) — SxxExx" via its watchlist show', async () => {
    const { svc } = build([row({ objectType: 'wanted_episode', objectId: 'we1' })]);
    const { items } = await svc.list({});
    expect(items[0].target).toEqual({
      label: 'Silo (2023) — S01E03',
      title: 'Silo (2023)',
      season: 1,
      episode: 3,
    });
  });

  it('names a media item from its own season/episode', async () => {
    const { svc } = build([row({ objectType: 'media_item', objectId: 'mi1' })]);
    const { items } = await svc.list({});
    expect(items[0].target?.label).toBe('Blindspot (2015) — S01E14');
  });

  it('falls back to parsing the release name in metadata (no extra query)', async () => {
    const { svc } = build([
      row({
        objectType: 'torrent',
        objectId: 'c0ed8b84',
        metadata: { name: 'Criminal.Minds.S19E01.1080p.HEVC.x265-MeGusta' },
      }),
    ]);
    const { items } = await svc.list({});
    expect(items[0].target?.label).toBe('Criminal Minds — S19E01');
  });

  it('does not double-append a year the title already carries', async () => {
    const { svc } = build([
      row({ objectType: 'torrent', objectId: 'h', metadata: { name: '9-1-1 (2018)' } }),
    ]);
    const { items } = await svc.list({});
    expect(items[0].target?.label).toBe('9-1-1 (2018)'); // not "9-1-1 (2018) (2018)"
  });

  it('leaves non-media rows unnamed', async () => {
    const { svc } = build([
      row({ objectType: 'setting', objectId: 'prowlarr', metadata: { name: 'EZTV' } }),
    ]);
    const { items } = await svc.list({});
    expect(items[0].target).toBeNull();
  });

  it('batches lookups — one query per object type, never per row', async () => {
    const rows = Array.from({ length: 25 }, (_, i) =>
      row({ id: `a${i}`, objectType: 'wanted_episode', objectId: 'we1' }),
    );
    const { svc, prisma } = build(rows);
    await svc.list({});
    expect(prisma.wantedEpisode.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.mediaAcquisitionWatchlistItem.findMany).toHaveBeenCalledTimes(1);
  });

  it('never fails the audit list when target resolution errors', async () => {
    const { svc, prisma } = build([row({ objectType: 'wanted_episode', objectId: 'we1' })]);
    prisma.wantedEpisode.findMany.mockRejectedValueOnce(new Error('db down'));
    const { items } = await svc.list({});
    expect(items).toHaveLength(1);
    expect(items[0].target).toBeNull();
  });
});
