import { MediaRelocationService } from './media-relocation.service';

/**
 * Path bookkeeping.
 *
 * The bug this closes: the rename engine moved files and told nobody. The row
 * kept the old path, the next scan inserted a second row at the new one and
 * pruned the first — and because MediaMetadata, MediaArtwork, MediaSubtitle and
 * MediaNfoFile all cascade from MediaItem, that prune destroyed the item's
 * whole enrichment. A rename cost the library its metadata, artwork, external
 * ids, manual match and lock.
 */
describe('MediaRelocationService', () => {
  const build = () => {
    const calls: Array<{ table: string; args: any }> = [];
    const counter = (table: string) =>
      jest.fn((args: any) => { calls.push({ table, args }); return { count: 1 }; });

    const prisma: any = {
      $transaction: jest.fn(async (ops: unknown[]) => ops),
      mediaItem: { updateMany: counter('mediaItem') },
      mediaFile: { updateMany: counter('mediaFile') },
      mediaSubtitle: { updateMany: counter('mediaSubtitle'), deleteMany: counter('mediaSubtitle.del') },
      mediaNfoFile: { updateMany: counter('mediaNfoFile'), deleteMany: counter('mediaNfoFile.del') },
      mediaArtwork: { updateMany: counter('mediaArtwork'), deleteMany: counter('mediaArtwork.del') },
    };
    return { svc: new MediaRelocationService(prisma), calls, prisma };
  };

  const OLD = '/media/tv/Show/old.mkv';
  const NEW = '/media/tv/Show/Season 01/Show - S01E03.mkv';

  it('moves every path-bearing record, not just the item', () => {
    const { svc, calls } = build();
    svc.recordMove(OLD, NEW);
    // Everything in a media folder belongs to the item it accompanies.
    expect(calls.map((c) => c.table).sort()).toEqual(
      ['mediaArtwork', 'mediaFile', 'mediaItem', 'mediaNfoFile', 'mediaSubtitle'],
    );
  });

  it('matches the exact old path, never a prefix', () => {
    // `/media/Show` also prefixes `/media/Show Two`; a prefix match would
    // rewrite records belonging to a different title.
    const { svc, calls } = build();
    svc.recordMove(OLD, NEW);
    for (const call of calls) {
      const where = call.args.where;
      const value = where.path ?? where.localPath;
      // A bare string is an equality match. A Prisma operator would be an
      // object — `{ startsWith }` / `{ contains }` — which is what would let a
      // relocation rewrite a neighbouring title's records.
      expect(value).toBe(OLD);
      expect(typeof value).toBe('string');
    }
  });

  it('uses artwork.localPath, since artwork has no path column', () => {
    const { svc, calls } = build();
    svc.recordMove(OLD, NEW);
    const art = calls.find((c) => c.table === 'mediaArtwork')!;
    expect(art.args.where).toEqual({ localPath: OLD });
    expect(art.args.data).toEqual({ localPath: NEW });
  });

  it('applies the whole relocation in one transaction', async () => {
    // A half-applied move leaves a row pointing at neither location.
    const { svc, prisma } = build();
    await svc.recordMove(OLD, NEW);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(5);
  });

  it('does nothing for a no-op move', async () => {
    const { svc, prisma } = build();
    await svc.recordMove(OLD, OLD);
    await svc.recordMove('', NEW);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('totals a batch across every table', async () => {
    const { svc } = build();
    const out = await svc.recordMoves([
      { from: '/a.mkv', to: '/b.mkv' },
      { from: '/a.srt', to: '/b.srt' },
    ]);
    expect(out.items).toBe(2);
    expect(out.subtitles).toBe(2);
  });

  it('applies a batch sequentially, so a rename chain cannot interleave', async () => {
    const { svc, prisma } = build();
    await svc.recordMoves([
      { from: '/a.mkv', to: '/b.mkv' },
      { from: '/b.mkv', to: '/c.mkv' },
    ]);
    // One transaction per move, in order — not one interleaved batch.
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });

  describe('deletion', () => {
    it('forgets sidecar rows', async () => {
      const { svc, calls } = build();
      await svc.recordDelete('/media/tv/Show/junk.srt');
      expect(calls.map((c) => c.table).sort()).toEqual(
        ['mediaArtwork.del', 'mediaNfoFile.del', 'mediaSubtitle.del'],
      );
    });

    it('never deletes the item itself', async () => {
      /*
       * Deleting MediaItem here would cascade its metadata and artwork away.
       * Cleanup removing a stray .srt is not a statement about the film — an
       * item whose VIDEO is gone is the scanner's business, which prunes it
       * deliberately and prunes duplicate groups with it.
       */
      const { svc, calls } = build();
      await svc.recordDelete('/media/tv/Show/junk.srt');
      expect(calls.some((c) => c.table.startsWith('mediaItem'))).toBe(false);
      expect(calls.some((c) => c.table.startsWith('mediaFile'))).toBe(false);
    });

    it('ignores an empty path rather than matching everything', async () => {
      const { svc, prisma } = build();
      await svc.recordDelete('');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('recordMoveSafe', () => {
    it('never lets bookkeeping fail a file operation that already succeeded', async () => {
      // The move happened on disk. Throwing would report a failed rename for
      // work that succeeded, and the caller could not tell the difference.
      const prisma: any = {
        $transaction: jest.fn(async () => { throw new Error('db down'); }),
        mediaItem: { updateMany: jest.fn() }, mediaFile: { updateMany: jest.fn() },
        mediaSubtitle: { updateMany: jest.fn() }, mediaNfoFile: { updateMany: jest.fn() },
        mediaArtwork: { updateMany: jest.fn() },
      };
      const svc = new MediaRelocationService(prisma);
      await expect(svc.recordMoveSafe(OLD, NEW)).resolves.toBeUndefined();
    });
  });
});
