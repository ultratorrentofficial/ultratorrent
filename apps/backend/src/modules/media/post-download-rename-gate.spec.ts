/**
 * The post-download pipeline renames only where the operator opted in.
 *
 * `autoOrganize` has to mean ONE thing — the app may rename or move files in
 * this library without being asked — across every path that does so. It was
 * first wired into `organizeLibrary` alone, and the gap was invisible because
 * something else was masking it: a library opted out of automatic organising
 * used to be spelled `mode: 'preview'`, and `MediaService.apply` short-circuits
 * on that mode, so stage 4 of this pipeline was already a silent no-op for
 * exactly those libraries.
 *
 * Giving them a real verb removed the accident that was doing the work. A
 * library that had never had a downloaded file renamed would have started
 * renaming every one of them, with nothing in the UI having changed to say so.
 *
 * No test caught it, because no test covered stage 4 at all — the fixtures
 * simply never asserted the rename either way. These do, in both directions.
 */
import { MediaProcessingService } from './media-processing.service';

function queueStub() {
  return {
    run: jest.fn(async (_t: string, _o: unknown, fn: (r: any) => any) => fn(async () => undefined)),
    create: jest.fn(), start: jest.fn(), progress: jest.fn(), complete: jest.fn(), fail: jest.fn(),
  } as any;
}

/** One enabled library covering /dl, holding one item from the download. */
function make(autoOrganize: boolean, mode = 'rename_in_place') {
  const library = {
    id: 'L', name: 'TV Shows', path: '/dl', mode, autoOrganize,
    isEnabled: true, artworkEnabled: false, nfoEnabled: false,
  };
  const prisma = {
    mediaLibrary: { findMany: jest.fn(async () => [library]) },
    mediaItem: {
      findMany: jest.fn(async () => [{ id: 'I1', path: '/dl/Show/ep.mkv' }]),
      findUnique: jest.fn(async () => ({
        id: 'I1', matchStatus: 'matched', metadata: { id: 'm' }, artwork: [],
      })),
    },
  } as any;
  const actions = { execute: jest.fn().mockResolvedValue(undefined) };
  const svc = new MediaProcessingService(
    prisma,
    { publish: jest.fn(() => ({ published: true })) } as any,
    // `evaluate` MUST return a promise: `fire()` chains `.catch()` onto it, and a
    // stub returning undefined throws a TypeError inside the scan stage's try —
    // which returns out of the whole workflow and makes every later assertion
    // fail for a reason that has nothing to do with what is being tested.
    { get: () => ({ evaluate: jest.fn().mockResolvedValue(undefined) }) } as any,
    { scanLibrary: jest.fn().mockResolvedValue({ scanned: 1 }) } as any,
    { identify: jest.fn().mockResolvedValue({ matchStatus: 'matched' }) } as any,
    { scan: jest.fn(), detectMissing: jest.fn().mockResolvedValue({ missing: [] }) } as any,
    {} as any,
    actions as any,
    queueStub(),
  );
  return { svc, actions };
}

const torrent = { name: 'Show.S01E01.1080p', savePath: '/dl/Show' } as never;

describe('post-download rename is gated on autoOrganize', () => {
  it('renames when the library is opted in', async () => {
    const { svc, actions } = make(true);
    await svc.handleTorrentCompleted(torrent);
    expect(actions.execute).toHaveBeenCalledWith('media_rename', { itemId: 'I1' });
  });

  it('does NOT rename when the library is opted out', async () => {
    // The regression in one line. Before the gate this renamed anyway, because
    // stage 4 read `library.mode` and never asked whether it was allowed to act.
    const { svc, actions } = make(false);
    await svc.handleTorrentCompleted(torrent);
    expect(actions.execute).not.toHaveBeenCalledWith('media_rename', expect.anything());
  });

  it('opting out stops the rename, not the rest of the pipeline', async () => {
    // Identification and metadata are not "moving files" — an opted-out library
    // should still be catalogued and enriched, just left where it lies. Gating
    // the whole workflow would trade one over-reach for another.
    const { svc, actions } = make(false);
    await svc.handleTorrentCompleted(torrent);
    expect(actions.execute).toHaveBeenCalledWith('media_fetch_metadata', { itemId: 'I1' });
  });

  it('a real verb alone is not permission — the flag decides', async () => {
    /*
     * The heart of the regression. `rename_in_place` is a perfectly capable
     * verb; that is precisely why it must not imply consent. Under the old
     * model this library was `preview` and could not act; converting it to a
     * real verb must not silently grant what the operator never granted.
     */
    const { svc, actions } = make(false, 'rename_move');
    await svc.handleTorrentCompleted(torrent);
    expect(actions.execute).not.toHaveBeenCalledWith('media_rename', expect.anything());
  });
});
