import { mkdtemp, mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MediaBulkService } from './media-bulk.service';

/**
 * Moving a film to another library moves its FOLDER.
 *
 * A movie owns its directory — poster, NFO, subtitles and extras all sit beside
 * the video — so the unit of the move is `Toy Story (1995)/`, not the .mp4
 * inside it. The previous version joined the target root with the file's
 * BASENAME: the film landed loose in the library root, contradicting the naming
 * template, and every sidecar subtitle stayed behind because subtitles are
 * `MediaSubtitle` rows and were never in the move set at all.
 *
 * The dangerous half is knowing when NOT to move a folder. A TV season folder
 * is shared by every episode of the season, so moving it because one episode
 * was selected would take the others into a library they do not belong to.
 */
function build(root: string, items: any[], strangers: any[] = []) {
  const updates: Record<string, any[]> = { item: [], file: [], subtitle: [], artwork: [] };
  const prisma = {
    mediaLibrary: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === 'target' ? { id: 'target', path: path.join(root, 'Animated Movies'), name: 'Animated' } : null),
    },
    mediaItem: {
      findMany: jest.fn(async () => items),
      // The "does anyone else live in this folder" probe.
      findFirst: jest.fn(async ({ where }: any) => {
        const prefix = where.path?.startsWith as string | undefined;
        if (!prefix) return null;
        return strangers.find((s) => s.path.startsWith(prefix)) ?? null;
      }),
      count: jest.fn(async () => items.length),
      update: jest.fn((args: any) => { updates.item.push(args); return args; }),
    },
    mediaFile: { update: jest.fn((args: any) => { updates.file.push(args); return args; }) },
    mediaSubtitle: { update: jest.fn((args: any) => { updates.subtitle.push(args); return args; }) },
    mediaArtwork: { update: jest.fn((args: any) => { updates.artwork.push(args); return args; }) },
    $transaction: jest.fn(async (ops: any[]) => ops),
  };
  const audit = { record: jest.fn(async () => undefined) };
  // Run the job body inline so the test observes the filesystem afterwards.
  const jobs = {
    runDetached: jest.fn(async (_type: string, _opts: unknown, fn: any) => {
      await fn(() => undefined, { isCancelled: () => false });
      return { jobId: 'job-1' };
    }),
  };
  const svc = new MediaBulkService(prisma as never, jobs as never, audit as never);
  return { svc, updates, prisma };
}

describe('moving a film to another library', () => {
  let root: string;
  let hdMovies: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'move-to-library-'));
    hdMovies = path.join(root, 'HD Movies');
    await mkdir(path.join(root, 'Animated Movies'), { recursive: true });
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function makeFilm(folderName: string) {
    const dir = path.join(hdMovies, folderName);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${folderName} - 1080p.mp4`), 'VIDEO');
    await writeFile(path.join(dir, `${folderName} - 1080p.srt`), 'SUBS');
    await writeFile(path.join(dir, 'poster.jpg'), 'ART');
    await writeFile(path.join(dir, 'movie.nfo'), 'NFO');
    return dir;
  }

  it('moves the whole folder, with everything in it', async () => {
    const dir = await makeFilm('Toy Story (1995)');
    const video = path.join(dir, 'Toy Story (1995) - 1080p.mp4');
    const subs = path.join(dir, 'Toy Story (1995) - 1080p.srt');

    const { svc, updates } = build(root, [{
      id: 'i1', path: video, libraryId: 'src',
      files: [{ id: 'f1', path: video }],
      subtitles: [{ id: 's1', path: subs }],
      artwork: [{ id: 'a1', localPath: path.join(dir, 'poster.jpg') }],
      library: { path: hdMovies },
    }]);

    await svc.moveToLibrary(['i1'], 'target', {});

    const moved = path.join(root, 'Animated Movies', 'Toy Story (1995)');
    // The folder arrived intact — not just the video.
    expect((await readdir(moved)).sort()).toEqual([
      'Toy Story (1995) - 1080p.mp4', 'Toy Story (1995) - 1080p.srt', 'movie.nfo', 'poster.jpg',
    ]);
    // And the source folder is gone rather than left as an empty shell.
    await expect(stat(dir)).rejects.toThrow();

    // Every stored path follows the media, including the subtitle that used to
    // be left behind entirely.
    expect(updates.item[0].data.path).toBe(path.join(moved, 'Toy Story (1995) - 1080p.mp4'));
    expect(updates.item[0].data.libraryId).toBe('target');
    expect(updates.subtitle[0].data.path).toBe(path.join(moved, 'Toy Story (1995) - 1080p.srt'));
    expect(updates.artwork[0].data.localPath).toBe(path.join(moved, 'poster.jpg'));
  });

  it('refuses to move a folder shared with an item that was not selected', async () => {
    // A season folder. Moving it because one episode was picked would drag the
    // rest of the season into a library they do not belong to.
    const season = path.join(hdMovies, 'Show (2020)', 'Season 01');
    await mkdir(season, { recursive: true });
    const ep1 = path.join(season, 'Show - S01E01.mkv');
    const ep2 = path.join(season, 'Show - S01E02.mkv');
    await writeFile(ep1, 'ONE');
    await writeFile(ep2, 'TWO');

    const { svc } = build(
      root,
      [{ id: 'i1', path: ep1, libraryId: 'src', files: [{ id: 'f1', path: ep1 }], subtitles: [], artwork: [], library: { path: hdMovies } }],
      [{ id: 'other', path: ep2 }],
    );

    await svc.moveToLibrary(['i1'], 'target', {});

    // The unselected episode stayed exactly where it was.
    await expect(stat(ep2)).resolves.toBeDefined();
    // And the selected one moved on its own, flat, as before.
    await expect(stat(path.join(root, 'Animated Movies', 'Show - S01E01.mkv'))).resolves.toBeDefined();
  });

  it('never moves the library root itself', async () => {
    // An item loose in the root has no folder of its own; treating the root as
    // "its folder" would move the entire library.
    const loose = path.join(hdMovies, 'Loose Film (2026).mp4');
    await mkdir(hdMovies, { recursive: true });
    await writeFile(loose, 'VIDEO');

    const { svc } = build(root, [{
      id: 'i1', path: loose, libraryId: 'src',
      files: [{ id: 'f1', path: loose }], subtitles: [], artwork: [],
      library: { path: hdMovies },
    }]);

    await svc.moveToLibrary(['i1'], 'target', {});

    // The library root survives, and only the file moved.
    await expect(stat(hdMovies)).resolves.toBeDefined();
    await expect(stat(path.join(root, 'Animated Movies', 'Loose Film (2026).mp4'))).resolves.toBeDefined();
  });

  it('keeps a hardlink intact, so an Intake import goes on seeding', async () => {
    const dir = await makeFilm('Seeded Film (2026)');
    const video = path.join(dir, 'Seeded Film (2026) - 1080p.mp4');
    // Stand in for the download-side name Media Intake hardlinks from.
    const download = path.join(root, 'download-copy.mp4');
    await (await import('node:fs/promises')).link(video, download);
    expect((await stat(video)).nlink).toBe(2);

    const { svc } = build(root, [{
      id: 'i1', path: video, libraryId: 'src',
      files: [{ id: 'f1', path: video }], subtitles: [], artwork: [],
      library: { path: hdMovies },
    }]);

    await svc.moveToLibrary(['i1'], 'target', {});

    const moved = path.join(root, 'Animated Movies', 'Seeded Film (2026)', 'Seeded Film (2026) - 1080p.mp4');
    // Both names still refer to the same bytes: renaming a directory entry
    // never breaks the other link, so the torrent keeps seeding.
    expect((await stat(moved)).nlink).toBe(2);
    await expect(stat(download)).resolves.toBeDefined();
  });

  it('refuses to overwrite a folder already in the target library', async () => {
    const dir = await makeFilm('Clash (2026)');
    const occupied = path.join(root, 'Animated Movies', 'Clash (2026)');
    await mkdir(occupied, { recursive: true });
    await writeFile(path.join(occupied, 'existing.mp4'), 'THE ONE ALREADY THERE');

    const video = path.join(dir, 'Clash (2026) - 1080p.mp4');
    const { svc } = build(root, [{
      id: 'i1', path: video, libraryId: 'src',
      files: [{ id: 'f1', path: video }], subtitles: [], artwork: [],
      library: { path: hdMovies },
    }]);

    await svc.moveToLibrary(['i1'], 'target', {});

    // Both survive: the occupant untouched, the source still where it was.
    await expect(stat(path.join(occupied, 'existing.mp4'))).resolves.toBeDefined();
    await expect(stat(video)).resolves.toBeDefined();
  });
});
