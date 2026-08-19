/**
 * Which torrents Media Intake is managing.
 *
 * The engine cannot answer this — an intake grab looks like any other torrent —
 * so the list has to carry it, and it has to carry it on BOTH paths (the REST
 * page and the live broadcast) or the badge disappears on the next tick.
 */
import { TorrentIntakeAnnotatorService } from './torrent-intake-annotator.service';

const torrent = (hash: string) => ({ hash, name: hash, parked: null }) as never;

function build(jobs: Array<Record<string, unknown>>, opts: { throws?: boolean } = {}) {
  const prisma = {
    mediaIntakeJob: {
      findMany: jest.fn(async (_args?: unknown) => {
        if (opts.throws) throw new Error('db down');
        return jobs;
      }),
    },
  };
  return { svc: new TorrentIntakeAnnotatorService(prisma as never), prisma };
}

describe('TorrentIntakeAnnotatorService', () => {
  it('marks the torrents an intake job claims and leaves the rest null', async () => {
    const { svc } = build([
      { id: 'j1', state: 'seeding', torrentHash: 'aaa', mediaItemId: null },
    ]);
    const out = await svc.annotate([torrent('aaa'), torrent('bbb')]);
    expect(out[0].intake).toEqual({ jobId: 'j1', state: 'seeding', imported: false });
    expect(out[1].intake).toBeNull();
  });

  it('matches case-insensitively', async () => {
    // The engine-reported hash and the stored one differ in case often enough
    // that an exact match silently finds nothing.
    const { svc } = build([
      { id: 'j1', state: 'imported', torrentHash: 'AAA', mediaItemId: 'item-1' },
    ]);
    const out = await svc.annotate([torrent('aaa')]);
    expect(out[0].intake).toMatchObject({ jobId: 'j1', imported: true });
  });

  it('reports imported only once a library item exists', async () => {
    const { svc } = build([
      { id: 'j1', state: 'importing', torrentHash: 'aaa', mediaItemId: null },
    ]);
    const out = await svc.annotate([torrent('aaa')]);
    expect(out[0].intake).toMatchObject({ imported: false });
  });

  it('lets the newest job win when a hash was re-imported', async () => {
    // A `Clear status` teardown leaves the old archived job behind; the row is
    // about the current one.
    const { svc } = build([
      { id: 'old', state: 'archived', torrentHash: 'aaa', mediaItemId: null },
      { id: 'new', state: 'seeding', torrentHash: 'aaa', mediaItemId: 'item-1' },
    ]);
    const out = await svc.annotate([torrent('aaa')]);
    expect(out[0].intake).toMatchObject({ jobId: 'new' });
  });

  it('scopes the query to the hashes on the page', async () => {
    // An install with thousands of intakes must not turn a 50-row page into a
    // thousand-row read.
    const { svc, prisma } = build([]);
    await svc.annotate([torrent('aaa'), torrent('bbb')]);
    const args = prisma.mediaIntakeJob.findMany.mock.calls[0]?.[0] as {
      where: { torrentHash: { in: string[] } };
    };
    expect(args.where.torrentHash.in).toEqual(['aaa', 'bbb']);
  });

  it('returns the list unchanged when the lookup fails', async () => {
    // It decorates a list; failing the list because the decoration failed
    // trades the whole answer for part of it.
    const { svc } = build([], { throws: true });
    const out = await svc.annotate([torrent('aaa')]);
    expect(out).toHaveLength(1);
    expect(out[0].hash).toBe('aaa');
  });

  it('does not query at all for an empty page', async () => {
    const { svc, prisma } = build([]);
    expect(await svc.annotate([])).toEqual([]);
    expect(prisma.mediaIntakeJob.findMany).not.toHaveBeenCalled();
  });
});
