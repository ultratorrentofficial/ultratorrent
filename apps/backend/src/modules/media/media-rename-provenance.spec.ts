import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { MediaService } from './media.service';

/**
 * A rename records the torrent its files came from.
 *
 * `RenameRequest.hash` did two unrelated jobs: it chose the file set (ask the
 * engine what that torrent owns) *and* it stamped the operation log. The
 * post-download pipeline could not use it, because passing a hash would have
 * switched gathering away from the library item it had just identified and
 * enriched — for a hardlink-import library, an entirely different set of files.
 * So it passed nothing, and the provenance went with it: on one live host all
 * 10,849 rename rows carry a null torrent, while `t.hash` sat in scope two
 * lines above the call.
 *
 * `sourceTorrentHash` separates the two. What these pin:
 *
 *   - the hash reaches the record when the caller supplies it,
 *   - and it does NOT reach the plan — files are still gathered from the path,
 *     which is the half that made the overloaded field unusable here.
 *
 * The second is the one worth a test: a future change that "simplifies" the two
 * fields back into one would still pass the first.
 */
function buildService(root: string, ops: any[], onGatherTorrent: () => void) {
  const prisma = {
    mediaLibrary: { findMany: jest.fn(async () => [{ path: root }]) },
    mediaRenameOperation: {
      create: jest.fn(async ({ data }: any) => {
        ops.push(data);
        return data;
      }),
    },
    mediaItem: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  };
  const config = { get: jest.fn(() => undefined) };
  const settings = { get: jest.fn(async () => undefined) };
  // Resolving an engine at all means gathering went down the torrent path.
  const registry = {
    resolve: jest.fn(async () => {
      onGatherTorrent();
      return { getFiles: async () => [] };
    }),
  };
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

const HASH = '44f0ab56d69f5eb9910dd5501b2b548c395fe813';

describe('rename provenance', () => {
  let root: string;
  let gatheredFromTorrent: boolean;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'rename-provenance-'));
    gatheredFromTorrent = false;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function runWith(req: Record<string, unknown>) {
    const src = path.join(root, 'A.Sense.Of.Dread.2026.1080p.WEBRip.mp4');
    const dest = path.join(root, 'A Sense of Dread (2026) - 1080p.mp4');
    await writeFile(src, 'PAYLOAD');

    const ops: any[] = [];
    const svc = buildService(root, ops, () => {
      gatheredFromTorrent = true;
    });
    jest.spyOn(svc as never, 'buildPlan' as never).mockResolvedValue({
      mode: 'rename_in_place',
      libraryPath: root,
      preset: 'plex',
      kind: 'movie',
      parsed: { title: 'A Sense of Dread', year: 2026 },
      items: [
        { source: src, destination: dest, action: 'rename', kind: 'movie',
          skipped: false, unchanged: false, isSubtitle: false, reason: 'primary media file' },
      ],
    } as never);

    const result = await svc.apply({ libraryPath: root, mode: 'rename_in_place', ...req } as never);
    return { ops, result };
  }

  it('records the torrent a path-gathered rename came from', async () => {
    const { ops, result } = await runWith({ path: root, sourceTorrentHash: HASH });

    expect(result.applied).toBe(1);
    const success = ops.filter((o) => o.status === 'success');
    expect(success).toHaveLength(1);
    expect(success[0].torrentHash).toBe(HASH);
  });

  it('does not let the provenance hash choose the files', async () => {
    // The whole reason for a separate field: supplying it must not turn a
    // path-gathered rename into a torrent-gathered one.
    await runWith({ path: root, sourceTorrentHash: HASH });
    expect(gatheredFromTorrent).toBe(false);
  });

  it('leaves the hash unset when nobody supplies one', async () => {
    // A library-wide sweep spans every torrent that ever fed it, so it passes
    // no hash — and must not invent one.
    const { ops } = await runWith({ path: root });
    expect(ops.filter((o) => o.status === 'success')[0].torrentHash).toBeUndefined();
  });
});
