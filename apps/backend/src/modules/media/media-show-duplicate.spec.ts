import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { MediaShowDuplicateService } from './media-show-duplicate.service';

/**
 * Duplicate SHOW FOLDERS — `Happy's Place (2024)` beside `Happys Place`, created
 * when something files a download into a folder named after a title instead of the
 * folder the show already has. These run against a real temp directory, because the
 * whole feature is about what happens to files on disk.
 */
describe('MediaShowDuplicateService', () => {
  let root: string;
  let lib: string;

  const show = (id: string, p: string, over: Partial<{ title: string; year: number | null; imdbId: string | null; canonicalKey: string }> = {}) => ({
    id,
    libraryId: 'lib1',
    path: p,
    title: over.title ?? path.basename(p),
    year: over.year ?? null,
    imdbId: over.imdbId ?? null,
    canonicalKey: over.canonicalKey ?? 'k',
  });

  /** Write a video file of `bytes` length. */
  const video = async (p: string, bytes: number) => {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, Buffer.alloc(bytes, 1));
  };

  function build(shows: any[], libraries: Array<{ path: string }> = [{ path: lib }]) {
    const removed: any[] = [];
    const prisma = {
      mediaShow: {
        findMany: jest.fn(async ({ where }: any = {}) =>
          where?.id?.in ? shows.filter((s) => where.id.in.includes(s.id)) : shows,
        ),
        findUnique: jest.fn(async ({ where }: any) => shows.find((s) => s.id === where.id) ?? null),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      mediaLibrary: { findMany: jest.fn(async () => libraries) },
      mediaAcquisitionWatchlistItem: { updateMany: jest.fn(async () => ({ count: 0 })) },
    };
    const filePath = {
      assertWithinHardRoots: jest.fn((p: string) => p),
      safety: { toRelative: (p: string) => p.slice(root.length) || '/' },
    };
    // The real FilesService is exercised elsewhere; here we only care THAT the
    // service delegates deletion to it (trash vs permanent), and with what.
    const files = {
      remove: jest.fn(async (dto: any) => {
        removed.push(dto);
        const abs = path.join(root, dto.path);
        const { rm } = await import('node:fs/promises');
        await rm(abs, { recursive: true, force: true });
        return { ok: true };
      }),
    };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const svc = new MediaShowDuplicateService(prisma as any, filePath as any, files as any, audit as any);
    return { svc, prisma, files, audit, removed };
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'ut-shows-'));
    lib = path.join(root, 'TV Shows');
    await mkdir(lib, { recursive: true });
  });

  // --- detection ------------------------------------------------------------

  describe('detect', () => {
    it('groups an apostrophe variant with its real folder', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      await video(path.join(a, 'Season 2', 'Happys.Place.S02E01.mkv'), 300);
      await video(path.join(b, 'Happys.Place.S02E09.mkv'), 100);

      const { svc } = build([
        show('s1', a, { canonicalKey: 'happys place', year: 2024 }),
        show('s2', b, { canonicalKey: 'happys place' }),
      ]);
      const [family] = await svc.detect();

      expect(family.reason).toBe('name');
      expect(family.needsReview).toBe(false);
      // The folder with the most videos is suggested, never applied on its own.
      expect(family.suggestedCanonicalShowId).toBe('s1');
      expect(family.members.map((m) => m.videoCount)).toEqual([1, 1]);
    });

    it('does NOT group two different shows that share a name but differ by year', async () => {
      // Dark Matter (2015) and Dark Matter (2024) are genuinely different series.
      const a = path.join(lib, 'Dark Matter (2015)');
      const b = path.join(lib, 'Dark Matter (2024)');
      await video(path.join(a, 'a.mkv'), 10);
      await video(path.join(b, 'b.mkv'), 10);

      const { svc } = build([
        show('s1', a, { canonicalKey: 'dark matter', year: 2015 }),
        show('s2', b, { canonicalKey: 'dark matter', year: 2024 }),
      ]);
      expect(await svc.detect()).toEqual([]);
    });

    it('groups by a shared IMDb id even when the names do not match — but flags it', async () => {
      // Real corruption: "Masters of the Air" carried High Desert's tt13701758.
      // Merging on the id alone would move one show's episodes into the other, so
      // the family is surfaced for review rather than presented as an obvious dupe.
      const a = path.join(lib, 'High Desert (2023)');
      const b = path.join(lib, 'Masters of the Air (2024)');
      await video(path.join(a, 'a.mkv'), 10);
      await video(path.join(b, 'b.mkv'), 10);

      const { svc } = build([
        show('s1', a, { canonicalKey: 'high desert', imdbId: 'tt13701758' }),
        show('s2', b, { canonicalKey: 'masters of the air', imdbId: 'tt13701758' }),
      ]);
      const [family] = await svc.detect();

      expect(family.reason).toBe('imdb');
      expect(family.needsReview).toBe(true);
    });

    it('says nothing about a library with no duplicates', async () => {
      const a = path.join(lib, 'The Wire (2002)');
      await video(path.join(a, 'a.mkv'), 10);
      const { svc } = build([show('s1', a, { canonicalKey: 'the wire', year: 2002 })]);
      expect(await svc.detect()).toEqual([]);
    });
  });

  // --- preview --------------------------------------------------------------

  describe('preview', () => {
    it('plans a move for every file with no counterpart, and touches no disk', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      await video(path.join(a, 'Season 2', 'Happys.Place.S02E01.mkv'), 300);
      await video(path.join(b, 'Happys.Place.S02E09.mkv'), 100);

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview('s1', ['s2']);

      expect(plan.moves).toHaveLength(1);
      expect(plan.moves[0].from).toBe(path.join(b, 'Happys.Place.S02E09.mkv'));
      expect(plan.collisions).toHaveLength(0);
      expect(plan.deletions).toEqual([b]);
      expect(plan.blockers).toEqual([]);
      // Nothing moved yet.
      expect((await readdir(b)).length).toBe(1);
    });

    it('keeps the larger file when the same episode is in both, and trashes the smaller', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      const big = path.join(a, 'Season 2', 'Happys.Place.S02E09.1080p.mkv');
      const small = path.join(b, 'Happys.Place.S02E09.720p.mkv');
      await video(big, 1000);
      await video(small, 200);

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview('s1', ['s2']);

      expect(plan.collisions).toHaveLength(1);
      expect(plan.collisions[0]).toMatchObject({
        season: 2,
        episode: 9,
        winner: 'existing',
        trashed: small,
      });
      // The winner is already in place, so there is nothing to move.
      expect(plan.moves).toHaveLength(0);
    });

    it('moves the incoming file in when IT is the larger one', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      const small = path.join(a, 'Season 2', 'Happys.Place.S02E09.720p.mkv');
      const big = path.join(b, 'Happys.Place.S02E09.1080p.mkv');
      await video(small, 200);
      await video(big, 1000);

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview('s1', ['s2']);

      expect(plan.collisions[0]).toMatchObject({ winner: 'incoming', trashed: small });
      expect(plan.moves).toHaveLength(1);
      expect(plan.moves[0].from).toBe(big);
    });

    it('refuses to delete a library root', async () => {
      await video(path.join(lib, 'loose.mkv'), 10);
      const other = path.join(lib, 'Show (2020)');
      await video(path.join(other, 'a.mkv'), 10);

      // A "show" whose path IS the library root — deleting it would take the library.
      const { svc } = build([show('s1', other), show('s2', lib)]);
      const plan = await svc.preview('s1', ['s2']);
      expect(plan.blockers.join(' ')).toMatch(/library root/i);
    });

    it('refuses to merge a folder into itself', async () => {
      const a = path.join(lib, 'Show (2020)');
      await video(path.join(a, 'a.mkv'), 10);
      const { svc } = build([show('s1', a), show('s2', a)]);
      const plan = await svc.preview('s1', ['s2']);
      expect(plan.blockers.join(' ')).toMatch(/into itself/i);
    });
  });

  // --- merge ----------------------------------------------------------------

  describe('merge', () => {
    it('re-homes the files, then permanently deletes the emptied folder', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      await video(path.join(a, 'Season 2', 'Happys.Place.S02E01.mkv'), 300);
      await video(path.join(b, 'Happys.Place.S02E09.mkv'), 100);
      await writeFile(path.join(b, 'poster.jpg'), 'x'); // stray sidecar goes with it

      const { svc, files, prisma } = build([show('s1', a), show('s2', b)]);
      const res = await svc.merge('s1', ['s2'], { userId: 'u1' });

      expect(res.moved).toBe(1);
      expect(res.deleted).toBe(1);
      // The file is now in the canonical folder…
      expect(await stat(path.join(a, 'Happys.Place.S02E09.mkv'))).toBeTruthy();
      // …and the duplicate folder is gone, deleted PERMANENTLY.
      expect(files.remove).toHaveBeenCalledWith(
        expect.objectContaining({ permanent: true }),
        expect.anything(),
      );
      await expect(stat(b)).rejects.toThrow();
      // The merged show row is dropped.
      expect(prisma.mediaShow.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s2'] } } });
    });

    it('trashes the collision loser rather than destroying it', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      await video(path.join(a, 'Season 2', 'Happys.Place.S02E09.1080p.mkv'), 1000);
      await video(path.join(b, 'Happys.Place.S02E09.720p.mkv'), 200);

      const { svc, files } = build([show('s1', a), show('s2', b)]);
      const res = await svc.merge('s1', ['s2'], {});

      expect(res.trashed).toBe(1);
      // permanent:false — the loser is recoverable from Trash.
      expect(files.remove).toHaveBeenCalledWith(
        expect.objectContaining({ permanent: false }),
        expect.anything(),
      );
      // The bigger file survives untouched.
      expect(Number((await stat(path.join(a, 'Season 2', 'Happys.Place.S02E09.1080p.mkv'))).size)).toBe(1000);
    });

    it('re-points a watchlist item bound to the merged show BEFORE the row is deleted', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      await video(path.join(a, 'a.mkv'), 10);
      await video(path.join(b, 'b.mkv'), 10);

      const { svc, prisma } = build([show('s1', a), show('s2', b)]);
      await svc.merge('s1', ['s2'], {});

      // Otherwise the FK's ON DELETE SET NULL would quietly unbind the show.
      expect(prisma.mediaAcquisitionWatchlistItem.updateMany).toHaveBeenCalledWith({
        where: { libraryShowId: { in: ['s2'] } },
        data: { libraryShowId: 's1' },
      });
    });

    it('refuses outright when the plan has a blocker', async () => {
      const a = path.join(lib, 'Show (2020)');
      await video(path.join(a, 'a.mkv'), 10);
      const { svc, files } = build([show('s1', a), show('s2', lib)]);

      await expect(svc.merge('s1', ['s2'], {})).rejects.toBeInstanceOf(BadRequestException);
      expect(files.remove).not.toHaveBeenCalled();
    });

    it('refuses when the canonical folder is also listed as a duplicate', async () => {
      const a = path.join(lib, 'Show (2020)');
      await video(path.join(a, 'a.mkv'), 10);
      const { svc } = build([show('s1', a)]);
      await expect(svc.merge('s1', ['s1'], {})).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
