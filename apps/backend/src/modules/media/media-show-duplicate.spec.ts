import { mkdtemp, mkdir, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { BadRequestException, ConflictException } from '@nestjs/common';
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

  const file = async (p: string, body = 'x') => {
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  };

  function build(shows: any[], libraries: Array<{ path: string }> = [{ path: lib }]) {
    const removed: any[] = [];
    // The persisted plan lives in `media_duplicate_resolutions`, keyed by id — the
    // whole point of the redesign is that `merge` reads it back rather than
    // recomputing, so the mock has to actually store it.
    const plans = new Map<string, any>();
    const journal: any[] = [];
    let seq = 0;
    const prisma = {
      mediaShow: {
        findMany: jest.fn(async ({ where }: any = {}) =>
          where?.id?.in ? shows.filter((s) => where.id.in.includes(s.id)) : shows,
        ),
        findUnique: jest.fn(async ({ where }: any) => shows.find((s) => s.id === where.id) ?? null),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
      mediaLibrary: { findMany: jest.fn(async () => libraries) },
      mediaAcquisitionWatchlistItem: {
        updateMany: jest.fn(async () => ({ count: 0 })),
        count: jest.fn(async () => 0),
        groupBy: jest.fn(async () => []),
      },
      mediaDuplicateResolution: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `plan${++seq}`, ...data };
          plans.set(row.id, row);
          return row;
        }),
        findUnique: jest.fn(async ({ where }: any) => plans.get(where.id) ?? null),
        update: jest.fn(async ({ where, data }: any) => {
          Object.assign(plans.get(where.id), data);
          return plans.get(where.id);
        }),
      },
      mediaDuplicateResolutionAction: {
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `act${journal.length}`, ...data };
          journal.push(row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = journal.find((r) => r.id === where.id);
          Object.assign(row, data);
          return row;
        }),
      },
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
    return { svc, prisma, files, audit, removed, journal };
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
      expect(family.reviewReason).toBeNull();
      // The folder with the most videos is suggested, never applied on its own.
      expect(family.suggestedCanonicalShowId).toBe('s1');
      expect(family.members.map((m) => m.videoCount)).toEqual([1, 1]);
    });

    it('reports what each folder uniquely contributes, and where they collide', async () => {
      // The number an operator actually decides on: keeping the folder with more
      // files is wrong if the other one holds the only copy of three episodes.
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'Show.S01E01.mkv'), 300);
      await video(path.join(a, 'Show.S01E02.mkv'), 300);
      await video(path.join(b, 'Show.S01E02.mkv'), 100);
      await video(path.join(b, 'Show.S01E03.mkv'), 100);
      await file(path.join(b, 'Show.S01E03.por.srt'), 'sub');

      const { svc } = build([
        show('s1', a, { canonicalKey: 'show', year: 2024 }),
        show('s2', b, { canonicalKey: 'show' }),
      ]);
      const [family] = await svc.detect();

      const byPath = Object.fromEntries(family.members.map((m) => [m.path, m]));
      expect(byPath[a].uniqueEpisodes).toEqual(['s1e1']);
      expect(byPath[b].uniqueEpisodes).toEqual(['s1e3']);
      expect(byPath[b].sidecars.subtitles).toBe(1);
      expect(family.collidingEpisodes).toEqual(['s1e2']);
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
      expect(family.reviewReason).toBe('metadata_conflict');
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
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });

      expect(plan.planId).toBeTruthy();
      expect(plan.moves).toHaveLength(1);
      expect(plan.moves[0].from).toBe(path.join(b, 'Happys.Place.S02E09.mkv'));
      expect(plan.collisions).toHaveLength(0);
      expect(plan.deletions).toEqual([b]);
      expect(plan.blockers).toEqual([]);
      // Nothing moved yet.
      expect((await readdir(b)).length).toBe(1);
    });

    it('carries an episode’s sidecars along with it', async () => {
      // The old merge moved video files only, then deleted the folder — which took
      // every .srt in it. A subtitle is content, not a by-product of the video.
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'Show.S01E01.mkv'), 300);
      await video(path.join(b, 'Show.S01E02.mkv'), 100);
      await file(path.join(b, 'Show.S01E02.en.srt'), 'sub');
      await file(path.join(b, 'Show.S01E02.nfo'), 'nfo');
      await file(path.join(b, 'poster.jpg'), 'art'); // show-level: NOT an episode sidecar

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });

      const moved = plan.moves.map((m) => path.basename(m.from)).sort();
      expect(moved).toEqual(['Show.S01E02.en.srt', 'Show.S01E02.mkv', 'Show.S01E02.nfo']);
      expect(moved).not.toContain('poster.jpg');
    });

    it('keeps the larger file when the same episode is in both, and trashes the smaller', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      const big = path.join(a, 'Season 2', 'Happys.Place.S02E09.1080p.mkv');
      const small = path.join(b, 'Happys.Place.S02E09.720p.mkv');
      await video(big, 1000);
      await video(small, 200);

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });

      expect(plan.collisions).toHaveLength(1);
      expect(plan.collisions[0]).toMatchObject({
        key: 's2e9',
        season: 2,
        episode: 9,
        winner: 'existing',
        chosenByOperator: false,
        trashed: small,
      });
      // The winner is already in place, so there is nothing to move.
      expect(plan.moves).toHaveLength(0);
    });

    it('lets the operator override the size rule for one episode', async () => {
      // Size is a proxy for quality and a poor one — a bloated upscale beats a clean
      // 1080p on bytes alone.
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      const bloated = path.join(a, 'Show.S01E01.2160p.mkv');
      const good = path.join(b, 'Show.S01E01.1080p.mkv');
      await video(bloated, 5000);
      await video(good, 900);

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({
        canonicalShowId: 's1',
        duplicateShowIds: ['s2'],
        collisionChoices: { s1e1: good },
      });

      expect(plan.collisions[0]).toMatchObject({
        winner: 'incoming',
        chosenByOperator: true,
        trashed: bloated,
      });
      expect(plan.moves.map((m) => m.from)).toContain(good);
    });

    it('refuses a chosen winner that is not one of that episode’s files', async () => {
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'Show.S01E01.mkv'), 500);
      await video(path.join(b, 'Show.S01E01.mkv'), 100);
      const unrelated = path.join(lib, 'Other', 'Other.S01E01.mkv');
      await video(unrelated, 100);

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({
        canonicalShowId: 's1',
        duplicateShowIds: ['s2'],
        collisionChoices: { s1e1: unrelated },
      });
      expect(plan.blockers.join(' ')).toMatch(/not one of that episode/i);
    });

    it('rescues a subtitle language the surviving copy does not have', async () => {
      // The losing copy is trashed and its folder deleted. A .por.srt that exists
      // nowhere else would go with it, so it is carried over to the keeper instead.
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'Show.S01E01.1080p.mkv'), 1000);
      await video(path.join(b, 'Show.S01E01.720p.mkv'), 200);
      await file(path.join(b, 'Show.S01E01.720p.por.srt'), 'sub');
      await file(path.join(b, 'Show.S01E01.720p.nfo'), 'nfo');

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });

      expect(plan.rescuedSubtitles).toHaveLength(1);
      expect(plan.rescuedSubtitles[0]).toMatchObject({ language: 'por' });
      // Renamed to sit beside the surviving video — otherwise no player finds it.
      expect(plan.rescuedSubtitles[0].to).toBe(path.join(a, 'Show.S01E01.1080p.por.srt'));
      // The .nfo describes a video that is going away; it is not rescued.
      expect(plan.rescuedSubtitles.map((r) => r.from)).not.toContain(path.join(b, 'Show.S01E01.720p.nfo'));
    });

    it('blocks rather than overwrite a file already in the canonical folder', async () => {
      // Two unparseable names that collapse to the same destination. Silently
      // overwriting one with the other is data loss with no record of it.
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'extra.mkv'), 500);
      await video(path.join(b, 'extra.mkv'), 100);

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      expect(plan.blockers.join(' ')).toMatch(/already exists/i);
    });

    it('blocks a metadata-conflict family until the operator acknowledges it', async () => {
      const a = path.join(lib, 'High Desert (2023)');
      const b = path.join(lib, 'Masters of the Air (2024)');
      await video(path.join(a, 'a.mkv'), 10);
      await video(path.join(b, 'b.mkv'), 10);
      const shows = [
        show('s1', a, { canonicalKey: 'high desert', imdbId: 'tt13701758' }),
        show('s2', b, { canonicalKey: 'masters of the air', imdbId: 'tt13701758' }),
      ];

      const { svc } = build(shows);
      const blocked = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      expect(blocked.blockers.join(' ')).toMatch(/Metadata Conflict/i);

      const acked = await svc.preview({
        canonicalShowId: 's1',
        duplicateShowIds: ['s2'],
        acknowledgeMetadataConflict: true,
      });
      expect(acked.blockers).toEqual([]);
    });

    it('refuses to delete a library root', async () => {
      await video(path.join(lib, 'loose.mkv'), 10);
      const other = path.join(lib, 'Show (2020)');
      await video(path.join(other, 'a.mkv'), 10);

      // A "show" whose path IS the library root — deleting it would take the library.
      const { svc } = build([show('s1', other), show('s2', lib)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      expect(plan.blockers.join(' ')).toMatch(/library root/i);
    });

    it('refuses to merge a folder into itself', async () => {
      const a = path.join(lib, 'Show (2020)');
      await video(path.join(a, 'a.mkv'), 10);
      const { svc } = build([show('s1', a), show('s2', a)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      expect(plan.blockers.join(' ')).toMatch(/into itself/i);
    });
  });

  // --- merge ----------------------------------------------------------------

  describe('merge', () => {
    it('re-homes the files, then sends the emptied folder to Trash', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      await video(path.join(a, 'Season 2', 'Happys.Place.S02E01.mkv'), 300);
      await video(path.join(b, 'Happys.Place.S02E09.mkv'), 100);
      await file(path.join(b, 'poster.jpg')); // show-level art stays behind, and that is fine

      const { svc, files, prisma } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      const res = await svc.merge(plan.planId, { userId: 'u1' });

      expect(res.status).toBe('completed');
      expect(res.moved).toBe(1);
      expect(res.deleted).toBe(1);
      // The file is now in the canonical folder…
      expect(await stat(path.join(a, 'Happys.Place.S02E09.mkv'))).toBeTruthy();
      // …and the duplicate folder went to TRASH, not to `rm`. The media is already
      // safe by then, but that is a belief about an operation that just happened.
      expect(files.remove).toHaveBeenCalledWith(
        expect.objectContaining({ permanent: false }),
        expect.anything(),
      );
      await expect(stat(b)).rejects.toThrow();
      expect(prisma.mediaShow.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['s2'] } } });
    });

    it('runs the stored plan, not a fresh one', async () => {
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'Show.S01E01.mkv'), 300);
      await video(path.join(b, 'Show.S01E02.mkv'), 100);

      const { svc, prisma } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      prisma.mediaShow.findUnique.mockClear();
      await svc.merge(plan.planId, {});

      // Nothing was re-derived from the show rows: execution read the plan back.
      expect(prisma.mediaShow.findUnique).not.toHaveBeenCalled();
    });

    it('refuses a plan whose folders changed after the preview', async () => {
      // The operator approved a picture of the disk. If the disk moved on, they did
      // not approve what would now run.
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'Show.S01E01.mkv'), 300);
      await video(path.join(b, 'Show.S01E02.mkv'), 100);

      const { svc, files } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      await video(path.join(b, 'Show.S01E03.mkv'), 100); // a new grab lands

      await expect(svc.merge(plan.planId, {})).rejects.toBeInstanceOf(ConflictException);
      expect(files.remove).not.toHaveBeenCalled();
    });

    it('refuses to run the same plan twice', async () => {
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'Show.S01E01.mkv'), 300);
      await video(path.join(b, 'Show.S01E02.mkv'), 100);

      const { svc } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      await svc.merge(plan.planId, {});
      await expect(svc.merge(plan.planId, {})).rejects.toBeInstanceOf(ConflictException);
    });

    it('trashes the collision loser rather than destroying it, and carries its subtitle over', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      const keeper = path.join(a, 'Season 2', 'Happys.Place.S02E09.1080p.mkv');
      await video(keeper, 1000);
      await video(path.join(b, 'Happys.Place.S02E09.720p.mkv'), 200);
      await file(path.join(b, 'Happys.Place.S02E09.720p.por.srt'), 'sub');

      const { svc, files } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      const res = await svc.merge(plan.planId, {});

      expect(res.trashed).toBe(1);
      expect(res.rescued).toBe(1);
      // permanent:false — the loser is recoverable from Trash.
      expect(files.remove).toHaveBeenCalledWith(
        expect.objectContaining({ permanent: false }),
        expect.anything(),
      );
      // The bigger file survives untouched, now with the only Portuguese subtitle
      // in the library sitting beside it.
      expect(Number((await stat(keeper)).size)).toBe(1000);
      expect(await stat(path.join(a, 'Season 2', 'Happys.Place.S02E09.1080p.por.srt'))).toBeTruthy();
    });

    it('journals every step, so a crash leaves a record of what was in flight', async () => {
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'Show.S01E01.mkv'), 300);
      await video(path.join(b, 'Show.S01E02.mkv'), 100);

      const { svc, journal } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      await svc.merge(plan.planId, {});

      expect(journal.map((r) => r.actionType)).toEqual(['move', 'repoint_watchlist', 'delete_empty_dir']);
      expect(journal.every((r) => r.status === 'completed')).toBe(true);
    });

    it('re-points a watchlist item bound to the merged show BEFORE the row is deleted', async () => {
      const a = path.join(lib, "Happy's Place (2024)");
      const b = path.join(lib, 'Happys Place');
      await video(path.join(a, 'a.mkv'), 10);
      await video(path.join(b, 'b.mkv'), 10);

      const { svc, prisma } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      await svc.merge(plan.planId, {});

      // Otherwise the FK's ON DELETE SET NULL would quietly unbind the show.
      expect(prisma.mediaAcquisitionWatchlistItem.updateMany).toHaveBeenCalledWith({
        where: { libraryShowId: { in: ['s2'] } },
        data: { libraryShowId: 's1' },
      });
    });

    it('keeps a folder that still holds media, and keeps its show row with it', async () => {
      // A loose subtitle — named after nothing, so no video carries it out. Deleting
      // the folder would destroy it; deleting the show row would hide the surviving
      // folder from the next detection pass, leaving a duplicate nobody can see.
      const a = path.join(lib, 'Show (2024)');
      const b = path.join(lib, 'Show');
      await video(path.join(a, 'Show.S01E01.mkv'), 300);
      await video(path.join(b, 'Show.S01E02.mkv'), 100);
      await file(path.join(b, 'stray.srt'), 'sub');

      const { svc, prisma } = build([show('s1', a), show('s2', b)]);
      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      const res = await svc.merge(plan.planId, {});

      expect(res.moved).toBe(1);
      expect(res.deleted).toBe(0);
      expect(res.skipped).toBe(1);
      expect(await stat(path.join(b, 'stray.srt'))).toBeTruthy();
      expect(prisma.mediaShow.deleteMany).not.toHaveBeenCalled();
    });

    it('refuses outright when the plan has a blocker', async () => {
      const a = path.join(lib, 'Show (2020)');
      await video(path.join(a, 'a.mkv'), 10);
      const { svc, files } = build([show('s1', a), show('s2', lib)]);

      const plan = await svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s2'] });
      await expect(svc.merge(plan.planId, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(files.remove).not.toHaveBeenCalled();
    });

    it('refuses when the canonical folder is also listed as a duplicate', async () => {
      const a = path.join(lib, 'Show (2020)');
      await video(path.join(a, 'a.mkv'), 10);
      const { svc } = build([show('s1', a)]);
      await expect(
        svc.preview({ canonicalShowId: 's1', duplicateShowIds: ['s1'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
