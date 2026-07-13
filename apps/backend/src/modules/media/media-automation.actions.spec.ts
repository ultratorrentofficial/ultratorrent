import { MediaAutomationActions } from './media-automation.actions';

/**
 * organizeLibrary reuses renameItem → MediaService.apply. We mock prisma (library
 * + items) and apply (returns a rename plan) to verify: mode gating, the
 * pre-filter (already-placed episodes skipped), the show-folder guard (a move to
 * a different show folder → needsReview, never applied), and the dry-run preview.
 *
 * NOTE the planning contract. organizeLibrary plans under the library's REAL mode
 * with `dryRun: true` (no disk writes) — NOT under mode 'preview'. Planning as
 * 'preview' mis-resolves an in-place move (it re-roots the file under the library
 * instead of reusing the show folder it already lives in), which tripped the guard
 * below for every show whose release name embeds a bare year ("Hijack.2023.S02E03").
 * So a "did it write?" assertion must look at `dryRun`, not at `mode`.
 */
const LOOSE_ITEMS = [
  { id: 'i1', season: 1, episode: 1, path: '/tv/Show/i1.mkv', files: [{ path: '/tv/Show/i1.mkv' }] },
  { id: 'i2', season: 1, episode: 2, path: '/tv/Show/i2.mkv', files: [{ path: '/tv/Show/i2.mkv' }] },
];
// Folder-preserving: relocate into a Season dir inside the SAME show folder.
const inSeason = (src: string) => src.replace('/Show/', '/Show/Season 01/');
// Folder-changing: renamer re-derived a different show folder (the guard case).
const otherShow = (src: string) => src.replace('/tv/Show/', '/tv/Show 2024/Season 01/');

function make(mode: string, items: any[] = LOOSE_ITEMS, destFn: (s: string) => string = inSeason) {
  const library = { id: 'lib1', mode, path: '/tv', preset: 'plex', template: null };
  const prisma = {
    mediaLibrary: { findUnique: jest.fn(async () => library) },
    mediaItem: {
      findMany: jest.fn(async () => items),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id, title: 'Show', year: null, path: `/tv/Show/${where.id}.mkv`,
        library, files: [{ path: `/tv/Show/${where.id}.mkv` }],
      })),
    },
  };
  const apply = jest.fn(async (req: { path: string; mode: string; dryRun?: boolean }) => ({
    // `dryRun` — not the mode — is what decides whether anything is written.
    applied: req.dryRun ? 0 : 1,
    skipped: 0,
    failed: 0,
    deleted: req.dryRun ? 0 : 1,
    plan: {
      items: [
        { source: req.path, destination: destFn(req.path), action: 'move', skipped: false },
        { source: '/tv/Show/RARBG.txt', destination: null, action: 'delete', skipped: false },
      ],
    },
  }));
  const svc = new MediaAutomationActions(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { apply } as any, {} as any,
  );
  return { svc, apply };
}

describe('MediaAutomationActions.organizeLibrary', () => {
  it('is a no-op for non-organize modes (hardlink/link/preview)', async () => {
    const { svc, apply } = make('hardlink');
    const res = await svc.organizeLibrary('lib1', {});
    expect(res).toMatchObject({ eligible: false, mode: 'hardlink', moves: [], deletes: [], needsReview: [] });
    expect(apply).not.toHaveBeenCalled();
  });

  it('skips episodes already in a Season NN dir (no plan build, no move)', async () => {
    const placed = [
      { id: 'p1', season: 1, episode: 1, path: '/tv/Show/Season 01/p1.mkv', files: [{ path: '/tv/Show/Season 01/p1.mkv' }] },
      { id: 'p2', season: 0, episode: 5, path: '/tv/Show/Specials/p2.mkv', files: [{ path: '/tv/Show/Specials/p2.mkv' }] },
    ];
    const { svc, apply } = make('rename_in_place', placed);
    const res = await svc.organizeLibrary('lib1', { dryRun: false });
    expect(res).toMatchObject({ eligible: true, moves: [], deletes: [], needsReview: [], applied: 0 });
    expect(apply).not.toHaveBeenCalled();
  });

  it('executes folder-preserving moves + junk deletes', async () => {
    const { svc, apply } = make('rename_in_place');
    const res = await svc.organizeLibrary('lib1', { dryRun: false });
    expect(res.eligible).toBe(true);
    expect(res.moves).toHaveLength(2);
    expect(res.deletes).toHaveLength(2);
    expect(res.needsReview).toHaveLength(0);
    expect(res.moves[0]).toMatchObject({ from: '/tv/Show/i1.mkv', to: '/tv/Show/Season 01/i1.mkv' });
    expect(res).toMatchObject({ applied: 2, deleted: 2 });
    // Always the library's own mode — planned dry, then executed for real.
    expect(apply.mock.calls.every((c: any[]) => c[0].mode === 'rename_in_place')).toBe(true);
    expect(apply.mock.calls.some((c: any[]) => c[0].dryRun === true)).toBe(true);
    expect(apply.mock.calls.some((c: any[]) => c[0].dryRun === false)).toBe(true);
  });

  it('GUARD: a move that leaves the show folder is flagged needsReview, not applied', async () => {
    const { svc, apply } = make('rename_in_place', LOOSE_ITEMS, otherShow);
    const res = await svc.organizeLibrary('lib1', { dryRun: false });
    expect(res.needsReview).toHaveLength(2);
    expect(res.needsReview[0]).toMatchObject({ from: '/tv/Show/i1.mkv', to: '/tv/Show 2024/Season 01/i1.mkv' });
    expect(res.moves).toHaveLength(0);
    expect(res.applied).toBe(0);
    // The plan is built, the guard rejects it, and nothing is ever written: every
    // apply is a dry run. (It is still planned under the library's real mode.)
    expect(apply.mock.calls.every((c: any[]) => c[0].dryRun === true)).toBe(true);
    expect(apply.mock.calls.every((c: any[]) => c[0].mode === 'rename_in_place')).toBe(true);
  });

  it('dryRun plans under the library\'s real mode and never writes', async () => {
    const { svc, apply } = make('rename_move', LOOSE_ITEMS);
    const res = await svc.organizeLibrary('lib1', { dryRun: true });
    expect(res).toMatchObject({ eligible: true, dryRun: true, applied: 0 });
    expect(res.moves).toHaveLength(2);
    expect(res.deletes).toHaveLength(2);
    // The moves are still fully resolved — but nothing touched the disk.
    expect(apply).toHaveBeenCalled();
    expect(apply.mock.calls.every((c: any[]) => c[0].dryRun === true)).toBe(true);
    expect(apply.mock.calls.every((c: any[]) => c[0].mode === 'rename_move')).toBe(true);
  });
});
