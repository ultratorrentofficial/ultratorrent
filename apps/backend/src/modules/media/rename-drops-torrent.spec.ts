import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MediaService } from './media.service';

/**
 * A rename that moves files drops the torrent that was seeding them.
 *
 * The libraries live INSIDE the download tree, and 3,298 of 3,303 movie files
 * on the live host have a link count of 1 — so a rename does not copy, it moves
 * the exact bytes a torrent is serving. Nothing tells the engine, so it finds
 * its files gone, rechecks to 0%, and downloads the release again next to the
 * copy just organised.
 *
 * Two things are load-bearing and have a test each:
 *
 *   - it removes the ENTRY, never the data. The payload is now the library's
 *     file; `removeTorrentAndData` would delete the film that was just
 *     organised, and unlike a removed torrent that cannot be undone.
 *   - a non-relocating mode (hardlink/copy) removes nothing. Those leave the
 *     download where it is, so the torrent goes on seeding perfectly well.
 */
function buildService(root: string, torrents: any[], provider: any) {
  const prisma = {
    mediaLibrary: { findMany: jest.fn(async () => [{ path: root }]) },
    mediaRenameOperation: { create: jest.fn(async ({ data }: any) => data) },
    mediaItem: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  };
  const config = { get: jest.fn(() => undefined) };
  const settings = { get: jest.fn(async () => undefined) };
  const registry = {
    resolve: jest.fn(async () => ({
      listTorrents: jest.fn(async () => torrents),
      ...provider,
    })),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const relocation = {
    recordMoveSafe: jest.fn(async () => undefined),
    recordDelete: jest.fn(async () => undefined),
  };
  const providers = { chain: jest.fn(async () => []), offline: jest.fn(() => ({ fetchDetails: async () => null })) };
  return new MediaService(
    prisma as never, config as never, settings as never, registry as never,
    audit as never, relocation as never, providers as never,
  );
}

const torrent = (over: any = {}) => ({
  hash: 'aaa111', name: 'A Sense Of Dread 2026 1080p', engineId: 'e1',
  savePath: '/downloads', contentPath: '', ...over,
});

describe('a rename that moves seeded files', () => {
  let root: string;
  let removeTorrent: jest.Mock;
  let removeTorrentAndData: jest.Mock;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rename-drops-torrent-'));
    removeTorrent = jest.fn(async () => undefined);
    removeTorrentAndData = jest.fn(async () => undefined);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function run(mode: string, contentPath: (dir: string) => string) {
    const relDir = path.join(root, 'A Sense Of Dread (2026) [1080p] [YTS]');
    const src = path.join(relDir, 'A.Sense.Of.Dread.2026.1080p.mp4');
    const dest = path.join(root, 'A Sense of Dread (2026)', 'A Sense of Dread (2026).mp4');
    await writeFile(path.join(root, 'placeholder'), 'x');
    await rm(relDir, { recursive: true, force: true });
    await (await import('node:fs/promises')).mkdir(relDir, { recursive: true });
    await writeFile(src, 'PAYLOAD');

    const svc = buildService(root, [torrent({ contentPath: contentPath(relDir) })], {
      removeTorrent, removeTorrentAndData,
    });
    jest.spyOn(svc as never, 'buildPlan' as never).mockResolvedValue({
      mode,
      libraryPath: root,
      preset: 'plex',
      kind: 'movie',
      parsed: { title: 'A Sense of Dread', year: 2026 },
      items: [
        { source: src, destination: dest, action: mode === 'hardlink' ? 'hardlink' : 'rename',
          kind: 'movie', skipped: false, unchanged: false, isSubtitle: false, reason: 'primary media file' },
      ],
    } as never);

    return svc.apply({ libraryPath: root, mode } as never);
  }

  it('removes the torrent ENTRY, and never its data', async () => {
    const result = await run('rename_in_place', (dir) => dir);

    expect(result.applied).toBe(1);
    expect(result.torrentsRemoved).toBe(1);
    expect(removeTorrent).toHaveBeenCalledWith('aaa111');
    // The payload IS the library's file now. Deleting it would delete the film.
    expect(removeTorrentAndData).not.toHaveBeenCalled();
  });

  it('leaves the torrent alone for a hardlink, which does not move anything', async () => {
    const result = await run('hardlink', (dir) => dir);
    expect(result.torrentsRemoved).toBe(0);
    expect(removeTorrent).not.toHaveBeenCalled();
  });

  it('removes nothing when no torrent owns the moved file', async () => {
    const result = await run('rename_in_place', () => '/somewhere/unrelated');
    expect(result.applied).toBe(1);
    expect(result.torrentsRemoved).toBe(0);
    expect(removeTorrent).not.toHaveBeenCalled();
  });

  it('still reports the rename as applied when the engine is unreachable', async () => {
    // The files are already moved and recorded by then; an engine that is down
    // must not turn a successful rename into a failed one.
    const relDir = path.join(root, 'Rel (2026)');
    const src = path.join(relDir, 'f.mp4');
    await (await import('node:fs/promises')).mkdir(relDir, { recursive: true });
    await writeFile(src, 'PAYLOAD');

    const prisma = {
      mediaLibrary: { findMany: jest.fn(async () => [{ path: root }]) },
      mediaRenameOperation: { create: jest.fn(async ({ data }: any) => data) },
      mediaItem: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    };
    const registry = { resolve: jest.fn(async () => { throw new Error('engine offline'); }) };
    const svc = new MediaService(
      prisma as never, { get: () => undefined } as never, { get: async () => undefined } as never,
      registry as never, { record: jest.fn(async () => undefined) } as never,
      { recordMoveSafe: jest.fn(async () => undefined), recordDelete: jest.fn(async () => undefined) } as never,
      { chain: jest.fn(async () => []), offline: jest.fn(() => ({ fetchDetails: async () => null })) } as never,
    );
    jest.spyOn(svc as never, 'buildPlan' as never).mockResolvedValue({
      mode: 'rename_in_place', libraryPath: root, preset: 'plex', kind: 'movie',
      parsed: { title: 'Rel', year: 2026 },
      items: [{ source: src, destination: path.join(root, 'Rel (2026)', 'Rel (2026).mp4'),
        action: 'rename', kind: 'movie', skipped: false, unchanged: false, isSubtitle: false, reason: 'primary' }],
    } as never);

    const result = await svc.apply({ libraryPath: root, mode: 'rename_in_place' } as never);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.torrentsRemoved).toBe(0);
  });
});
