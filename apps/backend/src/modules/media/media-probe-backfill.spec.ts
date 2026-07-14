import { MediaProbeBackfillService } from './media-probe-backfill.service';
import { ProbeError } from './media-probe.service';

/**
 * The backfill's contract is mostly about what happens when things go WRONG: a
 * corrupt file must fail exactly once (or it is re-probed on every tick forever), a
 * missing binary must be a no-op rather than 29,000 exceptions, and a row deleted by
 * a concurrent rescan must not take the batch down with it.
 */
describe('MediaProbeBackfillService', () => {
  const makePrisma = (files: Array<{ id: string; path: string; probeAttempts?: number }>) => ({
    mediaFile: {
      findMany: jest.fn().mockResolvedValue(files),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn().mockResolvedValue(0),
    },
  });

  const probeStub = (impl: (p: string) => Promise<any>, available = true) =>
    ({ isAvailable: jest.fn().mockResolvedValue(available), probe: jest.fn(impl) }) as any;

  it('writes measured metadata and stamps its provenance', async () => {
    const prisma = makePrisma([{ id: 'f1', path: '/m/a.mkv' }]);
    const probe = probeStub(async () => ({ videoCodec: 'x265', height: 1080, bitrateKbps: 4200 }));
    const svc = new MediaProbeBackfillService(prisma as any, probe);

    const r = await svc.runBatch(10);

    expect(r).toEqual({ probed: 1, failed: 0, retried: 0 });
    const data = prisma.mediaFile.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      videoCodec: 'x265',
      height: 1080,
      bitrateKbps: 4200,
      techSource: 'probe', // ← so a measured value is distinguishable from a guess
      probeError: null,
    });
    expect(data.probedAt).toBeInstanceOf(Date);
  });

  it('records WHY an unreadable file failed, so it is never retried', async () => {
    const prisma = makePrisma([{ id: 'bad', path: '/m/corrupt.mkv' }]);
    const probe = probeStub(async () => {
      throw new Error('Invalid data found when processing input');
    });
    const svc = new MediaProbeBackfillService(prisma as any, probe);

    const r = await svc.runBatch(10);

    expect(r).toEqual({ probed: 0, failed: 1, retried: 0 });
    const data = prisma.mediaFile.update.mock.calls[0][0].data;
    expect(data.probeError).toMatch(/Invalid data/);
    // probedAt stays null; probeError takes the row OUT of the working set
    // ({ probedAt: null, probeError: null }), so the next tick skips it.
    expect(data.probedAt).toBeUndefined();
  });

  it('one bad file does not abort the rest of the batch', async () => {
    const prisma = makePrisma([
      { id: 'a', path: '/m/a.mkv' },
      { id: 'bad', path: '/m/bad.mkv' },
      { id: 'c', path: '/m/c.mkv' },
    ]);
    const probe = probeStub(async (p: string) => {
      if (p.includes('bad')) throw new Error('boom');
      return { videoCodec: 'x264' };
    });
    const svc = new MediaProbeBackfillService(prisma as any, probe);

    expect(await svc.runBatch(10)).toEqual({ probed: 2, failed: 1, retried: 0 });
  });

  it('is a no-op when mediainfo is not installed (not 29k exceptions)', async () => {
    const prisma = makePrisma([{ id: 'f1', path: '/m/a.mkv' }]);
    const probe = probeStub(async () => ({}), false);
    const svc = new MediaProbeBackfillService(prisma as any, probe);

    expect(await svc.runBatch(10)).toEqual({ probed: 0, failed: 0, retried: 0 });
    expect(prisma.mediaFile.findMany).not.toHaveBeenCalled();
    expect(probe.probe).not.toHaveBeenCalled();
  });

  it('tolerates a row deleted mid-batch by a concurrent rescan', async () => {
    const prisma = makePrisma([{ id: 'gone', path: '/m/gone.mkv' }]);
    prisma.mediaFile.update.mockRejectedValue(new Error('Record to update not found'));
    const probe = probeStub(async () => {
      throw new Error('No such file');
    });
    const svc = new MediaProbeBackfillService(prisma as any, probe);

    // The failed probe AND the failed bookkeeping must both be swallowed.
    await expect(svc.runBatch(10)).resolves.toEqual({ probed: 0, failed: 1, retried: 0 });
  });

  it('only ever claims files that have neither been probed nor failed', async () => {
    const prisma = makePrisma([]);
    const svc = new MediaProbeBackfillService(prisma as any, probeStub(async () => ({})));

    await svc.runBatch(50);

    expect(prisma.mediaFile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { probedAt: null, probeError: null }, take: 50 }),
    );
  });

  describe('a transient failure is not the file\'s fault', () => {
    // probeError takes a file OUT of the working set FOREVER. The probe used to set it on
    // a TIMEOUT — which happens when the disks are busy serving Plex and says nothing
    // about the file. Two perfectly readable files (2.1 GB and 826 MB) were dropped this
    // way on live hosts; both probed fine by hand afterwards.
    const timeout = () => new ProbeError('probe timed out after 60s (disks busy)', true);

    it('defers a timed-out file instead of condemning it', async () => {
      const prisma = makePrisma([{ id: 'slow', path: '/m/big.mkv', probeAttempts: 0 }]);
      const svc = new MediaProbeBackfillService(
        prisma as any,
        probeStub(async () => {
          throw timeout();
        }),
      );

      const r = await svc.runBatch(10);

      expect(r).toEqual({ probed: 0, failed: 0, retried: 1 });
      const data = prisma.mediaFile.update.mock.calls[0][0].data;
      expect(data.probeAttempts).toBe(1);
      // The row must stay in the working set — no probeError, no probedAt.
      expect(data.probeError).toBeUndefined();
      expect(data.probedAt).toBeUndefined();
    });

    it('gives up once a file has timed out too many times', async () => {
      // Bounded: a file that ALWAYS times out must not be retried for eternity.
      const prisma = makePrisma([{ id: 'slow', path: '/m/big.mkv', probeAttempts: 2 }]);
      const svc = new MediaProbeBackfillService(
        prisma as any,
        probeStub(async () => {
          throw timeout();
        }),
      );

      const r = await svc.runBatch(10);

      expect(r).toEqual({ probed: 0, failed: 1, retried: 0 });
      const data = prisma.mediaFile.update.mock.calls[0][0].data;
      expect(data.probeAttempts).toBe(3);
      expect(data.probeError).toMatch(/timed out/);
    });

    it('a CORRUPT file is still condemned on the first attempt', async () => {
      // The distinction has to cut both ways, or the retry budget just delays the drop.
      const prisma = makePrisma([{ id: 'bad', path: '/m/corrupt.mkv', probeAttempts: 0 }]);
      const svc = new MediaProbeBackfillService(
        prisma as any,
        probeStub(async () => {
          throw new ProbeError('mediainfo returned unparseable JSON', false);
        }),
      );

      const r = await svc.runBatch(10);

      expect(r).toEqual({ probed: 0, failed: 1, retried: 0 });
      expect(prisma.mediaFile.update.mock.calls[0][0].data.probeError).toMatch(/unparseable/);
    });

    it('serves never-tried files before ones awaiting a retry', async () => {
      // Deferred files stay in the working set. Without an explicit order they could crowd
      // the head of every batch and starve files nobody has looked at yet — the same
      // starvation that froze the parked-torrent probe queue.
      const prisma = makePrisma([]);
      const svc = new MediaProbeBackfillService(prisma as any, probeStub(async () => ({})));

      await svc.runBatch(50);

      expect(prisma.mediaFile.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: { probeAttempts: 'asc' } }),
      );
    });
  });

  it('a slow tick cannot overlap the next one', async () => {
    const prisma = makePrisma([{ id: 'f1', path: '/m/a.mkv' }]);
    let inFlight = 0;
    let overlapped = false;
    const probe = probeStub(async () => {
      inFlight += 1;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 20));
      inFlight -= 1;
      return {};
    });
    const svc = new MediaProbeBackfillService(prisma as any, probe);

    await Promise.all([svc.tick(), svc.tick(), svc.tick()]);
    expect(overlapped).toBe(false);
  });
});
