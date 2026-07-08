import { MediaAutomationActions } from './media-automation.actions';

/**
 * organizeLibrary reuses renameItem → MediaService.apply. We mock prisma (library
 * + items) and apply (returns a rename plan) to verify the gating, the dry-run
 * (preview) path, and the move/delete aggregation.
 */
const LOOSE_ITEMS = [
  { id: 'i1', season: 1, episode: 1, path: '/tv/Show/i1.mkv', files: [{ path: '/tv/Show/i1.mkv' }] },
  { id: 'i2', season: 1, episode: 2, path: '/tv/Show/i2.mkv', files: [{ path: '/tv/Show/i2.mkv' }] },
];

function make(mode: string, items: any[] = LOOSE_ITEMS) {
  const library = { id: 'lib1', mode, path: '/tv', preset: 'plex', template: null };
  const prisma = {
    mediaLibrary: { findUnique: jest.fn(async () => library) },
    mediaItem: {
      findMany: jest.fn(async () => items),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
        title: 'Show',
        year: null,
        path: `/tv/Show/${where.id}.mkv`,
        library,
        files: [{ path: `/tv/Show/${where.id}.mkv` }],
      })),
    },
  };
  // apply returns one move (root → Season 01) + one junk delete per item.
  const apply = jest.fn(async (req: { path: string; mode: string }) => ({
    applied: req.mode === 'preview' ? 0 : 1,
    skipped: 0,
    failed: 0,
    deleted: req.mode === 'preview' ? 0 : 1,
    plan: {
      items: [
        { source: req.path, destination: req.path.replace('/Show/', '/Show/Season 01/'), action: 'move', skipped: false },
        { source: '/tv/Show/RARBG.txt', destination: null, action: 'delete', skipped: false },
      ],
    },
  }));
  const media = { apply };
  const svc = new MediaAutomationActions(
    prisma as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, media as any, {} as any,
  );
  return { svc, prisma, apply };
}

describe('MediaAutomationActions.organizeLibrary', () => {
  it('is a no-op for non-organize modes (hardlink/link/preview)', async () => {
    const { svc, apply } = make('hardlink');
    const res = await svc.organizeLibrary('lib1', {});
    expect(res).toMatchObject({ eligible: false, mode: 'hardlink', moves: [], deletes: [] });
    expect(apply).not.toHaveBeenCalled();
  });

  it('executes moves + junk deletes for a rename_in_place library', async () => {
    const { svc, apply } = make('rename_in_place');
    const res = await svc.organizeLibrary('lib1', { dryRun: false });
    expect(res.eligible).toBe(true);
    // Two items, each contributing one move + one delete.
    expect(res.moves).toHaveLength(2);
    expect(res.deletes).toHaveLength(2);
    expect(res.moves[0]).toMatchObject({ from: '/tv/Show/i1.mkv', to: '/tv/Show/Season 01/i1.mkv' });
    expect(res).toMatchObject({ applied: 2, deleted: 2 });
    // Executed with the library's own mode.
    expect(apply.mock.calls[0][0].mode).toBe('rename_in_place');
  });

  it('skips episodes already in a Season NN dir (no plan build, no move)', async () => {
    const placed = [
      { id: 'p1', season: 1, episode: 1, path: '/tv/Show/Season 01/p1.mkv', files: [{ path: '/tv/Show/Season 01/p1.mkv' }] },
      { id: 'p2', season: 2, episode: 5, path: '/tv/Show/Specials/p2.mkv', files: [{ path: '/tv/Show/Specials/p2.mkv' }] },
    ];
    const { svc, apply } = make('rename_in_place', placed);
    const res = await svc.organizeLibrary('lib1', { dryRun: false });
    expect(res).toMatchObject({ eligible: true, moves: [], deletes: [], applied: 0 });
    expect(apply).not.toHaveBeenCalled(); // no expensive per-item plan build
  });

  it('dryRun previews via preview mode without executing', async () => {
    const { svc, apply } = make('rename_move');
    const res = await svc.organizeLibrary('lib1', { dryRun: true });
    expect(res).toMatchObject({ eligible: true, dryRun: true, applied: 0 });
    // Still reports the planned moves/deletes so the operator can review.
    expect(res.moves).toHaveLength(2);
    expect(res.deletes).toHaveLength(2);
    // Planned in preview mode (no disk changes).
    expect(apply.mock.calls.every((c: any[]) => c[0].mode === 'preview')).toBe(true);
  });
});
