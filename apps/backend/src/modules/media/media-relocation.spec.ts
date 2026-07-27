import { MediaRelocationService } from './media-relocation.service';

/**
 * Path bookkeeping.
 *
 * The bug this closes: the rename engine moved files and told nobody. The row
 * kept the old path, the next scan inserted a second row at the new one and
 * pruned the first — and because MediaMetadata, MediaArtwork, MediaSubtitle and
 * MediaNfoFile all cascade from MediaItem, that prune destroyed the item's
 * whole enrichment. The file manager never updated anything at all.
 *
 * Prisma cannot express "rewrite this path prefix", so the service uses raw
 * SQL. These tests assert on the SQL that would actually run.
 */
describe('MediaRelocationService', () => {
  const build = () => {
    const sql: Array<{ query: string; params: unknown[] }> = [];
    const prisma: any = {
      $executeRawUnsafe: jest.fn((query: string, ...params: unknown[]) => {
        sql.push({ query, params });
        return 1;
      }),
      $transaction: jest.fn(async (ops: unknown[]) => ops),
    };
    return { svc: new MediaRelocationService(prisma), prisma, sql };
  };

  const tables = (sql: Array<{ query: string }>) =>
    sql.map((s) => (s.query.match(/(?:UPDATE|DELETE FROM)\s+(\w+)/) ?? [])[1]).sort();

  const ALL = [
    'media_artwork', 'media_files', 'media_items', 'media_nfo_files', 'media_subtitles',
  ];

  const OLD = '/media/tv/Show/old.mkv';
  const NEW = '/media/tv/Show/Season 01/new.mkv';

  describe('moving', () => {
    it('touches every path-bearing record, not just the item', async () => {
      // Everything in a media folder belongs to the item it accompanies.
      const { svc, sql } = build();
      await svc.recordMove(OLD, NEW);
      expect(tables(sql)).toEqual(ALL);
    });

    it('follows a moved FILE by exact match', async () => {
      const { svc, sql } = build();
      await svc.recordMove(OLD, NEW);
      for (const s of sql) {
        expect(s.params[0]).toBe(OLD);
        expect(s.params[1]).toBe(NEW);
      }
    });

    it('follows everything inside a moved FOLDER', async () => {
      /*
       * Renaming `Vivo (2021)` moves every file beneath it. Matching only the
       * exact path would update nothing at all — which is exactly what the file
       * manager did before this existed.
       */
      const { svc, sql } = build();
      await svc.recordMove('/media/movies/Vivo (2021)', '/media/movies/Vivo (2021) [1080p]');
      for (const s of sql) {
        expect(s.query).toContain('substring');
        // The trailing slash is the containment boundary.
        expect(s.params[2]).toBe('/media/movies/Vivo (2021)/');
        expect(s.params[3]).toBe('/media/movies/Vivo (2021) [1080p]/');
      }
    });

    it('bounds the prefix with a slash, so a sibling name cannot match', async () => {
      // `/media/Show` also prefixes `/media/Show Two`.
      const { svc, sql } = build();
      await svc.recordMove('/media/Show', '/media/Renamed');
      expect(sql[0].params[2]).toBe('/media/Show/');
    });

    it('never uses LIKE, which a path containing % or _ would break', async () => {
      // Both are legitimate filename characters and LIKE metacharacters.
      const { svc, sql } = build();
      await svc.recordMove('/media/100%_Wolf', '/media/Renamed');
      for (const s of sql) expect(s.query).not.toContain('LIKE');
    });

    it('binds every value rather than interpolating it', async () => {
      const { svc, sql } = build();
      await svc.recordMove("/media/O'Brien.mkv", '/media/x.mkv');
      for (const s of sql) {
        expect(s.query).not.toContain("O'Brien");
        expect(s.params).toContain("/media/O'Brien.mkv");
      }
    });

    it('applies the whole relocation in one transaction', async () => {
      // A half-applied move leaves a row pointing at neither location.
      const { svc, prisma } = build();
      await svc.recordMove(OLD, NEW);
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(5);
    });

    it('does nothing for a no-op or empty move', async () => {
      const { svc, prisma } = build();
      await svc.recordMove(OLD, OLD);
      await svc.recordMove('', NEW);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('applies a batch sequentially, so a rename chain cannot interleave', async () => {
      const { svc, prisma } = build();
      await svc.recordMoves([
        { from: '/a.mkv', to: '/b.mkv' },
        { from: '/b.mkv', to: '/c.mkv' },
      ]);
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('deleting', () => {
    it('removes the item too, not only its sidecars', async () => {
      /*
       * An earlier version withheld the item, reasoning the scanner would prune
       * it. That was wrong: if the video is gone the item goes regardless, and
       * withholding it bought only a window in which the database described a
       * file that did not exist.
       */
      const { svc, sql } = build();
      await svc.recordDelete('/media/movies/Vivo (2021)/Vivo (2021).mkv');
      expect(tables(sql)).toEqual(ALL);
    });

    it('clears everything beneath a deleted FOLDER', async () => {
      // The common case from the file manager.
      const { svc, sql } = build();
      await svc.recordDelete('/media/movies/Vivo (2021)');
      for (const s of sql) {
        expect(s.params[1]).toBe('/media/movies/Vivo (2021)/');
        expect(s.query).toContain('substring');
      }
    });

    it('deletes items LAST, after the sidecars are counted', async () => {
      // Deleting the item cascades its remaining children, which would make
      // every earlier count meaningless.
      const { svc, sql } = build();
      await svc.recordDelete('/media/x.mkv');
      const order = sql.map((s) => (s.query.match(/DELETE FROM\s+(\w+)/) ?? [])[1]);
      expect(order[order.length - 1]).toBe('media_items');
      expect(order.indexOf('media_subtitles')).toBeLessThan(order.indexOf('media_items'));
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
        $executeRawUnsafe: jest.fn(),
        $transaction: jest.fn(async () => { throw new Error('db down'); }),
      };
      const svc = new MediaRelocationService(prisma);
      await expect(svc.recordMoveSafe('/a.mkv', '/b.mkv')).resolves.toBeUndefined();
    });
  });
});
