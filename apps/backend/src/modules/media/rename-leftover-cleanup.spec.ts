import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MediaService } from './media.service';

/**
 * The release folder a rename leaves behind.
 *
 * Renaming "2 37 (2006) [BLURAY] [1080p] [BluRay] [YTS.GG - YTS.BZ]" from the
 * Library Browser moved the film into "2 37 (2006)" perfectly — and left the
 * original folder standing, holding `YIFYStatus.com.txt` and
 * `YTS.GG - Official site.jpg`. Cleanup was enabled, both files matched the
 * configured patterns, and the run still reported `deleted: 0`.
 *
 * The cause is a scope mismatch, not a matching bug. The plan's cleanup pass
 * can only mark files it was GIVEN, and a rename started from a library item is
 * given exactly one: the video. The junk beside it was never in the batch, so
 * nothing deleted it, so the folder was never empty, so `pruneEmptyDirs` could
 * not fire. Every release folder survived every rename.
 *
 * These cover the leftover sweep that closes that gap, and the three things it
 * must refuse to do.
 */
function buildService(root: string, cleanup: unknown) {
  const prisma = {
    mediaLibrary: {
      findMany: jest.fn(async () => [{ path: root, autoOrganize: true }]),
    },
    mediaRenameOperation: { create: jest.fn(async ({ data }: any) => data) },
    mediaItem: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  };
  const config = { get: jest.fn(() => undefined) };
  const settings = {
    get: jest.fn(async (key: string) => (key === 'media.cleanup' ? cleanup : undefined)),
  };
  const registry = { resolve: jest.fn(async () => { throw new Error('no engine'); }) };
  const audit = { record: jest.fn(async () => undefined) };
  const relocation = {
    recordMoveSafe: jest.fn(async () => undefined),
    recordDelete: jest.fn(async () => undefined),
  };
  const providers = {
    chain: jest.fn(async () => []),
    offline: jest.fn(() => ({ fetchDetails: async () => null })),
  };
  return new MediaService(
    prisma as never, config as never, settings as never, registry as never,
    audit as never, relocation as never, providers as never,
  );
}

const CLEANUP = {
  enabled: true,
  deleteGlobs: ['*.txt', 'YTS.GG - Official site.jpg'],
  subtitleKeepLanguages: [],
  pruneEmptyDirs: true,
  removeLeftoverTorrent: true,
};

const RELEASE = '2 37 (2006) [BLURAY] [1080p] [BluRay] [YTS.GG - YTS.BZ]';

describe('the leftovers a library-item rename cannot see', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rename-leftover-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * Runs a single-file rename out of a release folder — the exact shape the
   * Library Browser produces, where the plan contains only the video.
   */
  async function run(opts: {
    extras?: string[];
    cleanup?: unknown;
    mode?: string;
  } = {}) {
    const relDir = path.join(root, RELEASE);
    await mkdir(relDir, { recursive: true });
    const src = path.join(relDir, '2 37 (2006) - 1080p.mp4');
    await writeFile(src, 'FILM');
    for (const extra of opts.extras ?? ['YIFYStatus.com.txt', 'YTS.GG - Official site.jpg']) {
      const full = path.join(relDir, extra);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, 'junk');
    }

    const dest = path.join(root, '2 37 (2006)', '2 37 (2006) - 1080p.mp4');
    const svc = buildService(root, opts.cleanup ?? CLEANUP);
    jest.spyOn(svc as never, 'allowedRoots' as never).mockResolvedValue([root] as never);
    jest.spyOn(svc as never, 'buildPlan' as never).mockResolvedValue({
      mode: opts.mode ?? 'rename_in_place',
      libraryPath: root,
      preset: 'plex',
      kind: 'movie',
      parsed: { title: '2 37', year: 2006 },
      // ONE item — the video. This is the whole point: the junk is not here.
      items: [
        {
          source: src, destination: dest, action: 'rename', kind: 'movie',
          skipped: false, unchanged: false, isSubtitle: false,
          reason: 'primary media file',
        },
      ],
      warnings: [],
    } as never);

    const result = await svc.apply({
      path: relDir, libraryPath: root, mode: opts.mode ?? 'rename_in_place',
    } as never);
    return { result, relDir, dest };
  }

  it('deletes the junk beside the film and removes the emptied folder', async () => {
    const { result, relDir, dest } = await run();

    // The film landed.
    expect((await stat(dest)).isFile()).toBe(true);
    // The release folder is gone entirely — junk deleted, then pruned.
    await expect(stat(relDir)).rejects.toThrow();
    expect(result.applied).toBe(1);
  });

  it('reports the leftovers it removed instead of claiming it deleted nothing', async () => {
    // The symptom that made this invisible: a run that emptied a folder still
    // reported `deleted: 0`, so nothing in the audit trail said it had acted.
    const { result } = await run();
    expect(result.deleted).toBe(2);
  });

  it('leaves the folder when nothing matches the patterns', async () => {
    const { relDir } = await run({ extras: ['notes.nfo'] });

    // Not matched, so not deleted — and therefore not pruned either. A rename
    // must not remove a file the operator never asked it to.
    expect(await readdir(relDir)).toEqual(['notes.nfo']);
  });

  it('does nothing at all when cleanup is disabled', async () => {
    const { result, relDir } = await run({ cleanup: { ...CLEANUP, enabled: false } });

    expect(result.deleted).toBe(0);
    expect((await readdir(relDir)).sort()).toEqual([
      'YIFYStatus.com.txt', 'YTS.GG - Official site.jpg',
    ]);
  });
});

describe('what the leftover sweep refuses to delete', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rename-leftover-guard-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function sweep(dir: string, globs: string[], cleanup = CLEANUP) {
    const svc = buildService(root, cleanup);
    return (svc as never as {
      deleteMatchingLeftovers(d: string, g: string[]): Promise<number>;
    }).deleteMatchingLeftovers(dir, globs);
  }

  it('never a video, however broad the pattern', async () => {
    /*
     * The refusal that matters most. A release folder can hold a second film,
     * and `*` is a pattern an operator will eventually write. The plan's own
     * cleanup pass refuses to delete a non-sample video no matter how it
     * matched; this sweep has to hold the same line or it becomes the easier
     * way to lose a film.
     */
    const dir = path.join(root, 'rel');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'Another.Film.2019.mkv'), 'FILM');
    await writeFile(path.join(dir, 'junk.txt'), 'junk');

    const deleted = await sweep(dir, ['*']);

    expect(deleted).toBe(1);
    expect(await readdir(dir)).toEqual(['Another.Film.2019.mkv']);
  });

  it('never a directory, even one whose name matches', async () => {
    const dir = path.join(root, 'rel');
    await mkdir(path.join(dir, 'Subs'), { recursive: true });

    const deleted = await sweep(dir, ['*']);

    expect(deleted).toBe(0);
    expect(await readdir(dir)).toEqual(['Subs']);
  });

  it('deletes nothing when no patterns are configured', async () => {
    // An empty pattern list means "delete nothing", not "match everything".
    const dir = path.join(root, 'rel');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'junk.txt'), 'junk');

    expect(await sweep(dir, [])).toBe(0);
    expect(await readdir(dir)).toEqual(['junk.txt']);
  });

  it('survives a folder it cannot read', async () => {
    // A tidiness sweep must never be the thing that fails a rename.
    await expect(sweep(path.join(root, 'does-not-exist'), ['*.txt'])).resolves.toBe(0);
  });
});
