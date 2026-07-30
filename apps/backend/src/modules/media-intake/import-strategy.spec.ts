/**
 * Executing an import.
 *
 * The properties pinned here are the ones whose failure is silent: an audit
 * that records a strategy which did not run, a torrent left seeding from an
 * empty directory, and a `move` nobody asked for.
 */
import { ImportStrategyService, type ImportRequest } from './import-strategy.service';
import type { StorageCapabilities } from '@ultratorrent/shared';

const placed: Array<{ action: string; src: string; dest: string }> = [];
let placeBehaviour: (action: string) => { action: string; fellBack: boolean; reason?: string };

jest.mock('../../common/file-placement', () => ({
  placeFile: jest.fn(async (action: string, src: string, dest: string) => {
    placed.push({ action, src, dest });
    return placeBehaviour(action);
  }),
}));
jest.mock('node:fs/promises', () => ({ mkdir: jest.fn(async () => undefined) }));

const caps = (over: Partial<StorageCapabilities> = {}): StorageCapabilities => ({
  sameDevice: false, hardlink: false, reflink: false, symlink: false,
  providerRelocation: false, ...over,
});

function build(opts: { movesData?: boolean; resolveThrows?: boolean } = {}) {
  const moved: Array<{ hash: string; dest: string }> = [];
  const engines = {
    resolve: jest.fn(async () => {
      if (opts.resolveThrows) throw new Error('engine offline');
      return {
        relocationMovesData: () => opts.movesData ?? true,
        moveStorage: jest.fn(async (hash: string, dest: string) => { moved.push({ hash, dest }); }),
      };
    }),
  };
  const paths = { toSpace: jest.fn(async (p: string) => p.replace('/media', '/downloads')) };
  const svc = new ImportStrategyService(engines as never, paths as never);
  for (const level of ['log', 'warn'] as const) {
    jest.spyOn((svc as never as { logger: Record<string, (m: string) => void> }).logger, level)
      .mockImplementation(() => undefined);
  }
  return { svc, engines, paths, moved };
}

const req = (over: Partial<ImportRequest> = {}): ImportRequest => ({
  source: '/media/staging/Show.S01E01.mkv',
  destination: '/media/TV/Show/Show - S01E01.mkv',
  capabilities: caps({ sameDevice: true, hardlink: true }),
  torrentHash: 'abc', engineId: 'engine-1', ...over,
});

beforeEach(() => {
  placed.length = 0;
  placeBehaviour = (action) => ({ action, fellBack: false });
});

describe('strategy execution', () => {
  it('hardlinks when the storage allows it', async () => {
    const { svc } = build();
    const out = await svc.execute(req());
    expect(out.strategy).toBe('hardlink');
    expect(placed[0]).toMatchObject({ action: 'hardlink' });
    expect(out.sourcePreserved).toBe(true);
  });

  it('records what actually ran when a hardlink falls back to a copy', async () => {
    /*
     * The audit question is "why did this consume 40GB". Recording the chosen
     * strategy rather than the executed one would answer it wrongly, and the
     * fallback is invisible otherwise — the import still succeeded.
     */
    placeBehaviour = () => ({ action: 'copy', fellBack: true, reason: 'EXDEV' });
    const { svc } = build();
    const out = await svc.execute(req());
    expect(out.strategy).toBe('copy');
    expect(out.fellBack).toBe(true);
    expect(out.reason).toMatch(/EXDEV/);
  });

  it('never moves unless explicitly asked', async () => {
    // Inferring `move` would end seeding because a filesystem lacked a feature.
    const { svc } = build();
    const out = await svc.execute(req({ capabilities: caps() }));
    expect(out.strategy).not.toBe('move');
    expect(out.sourcePreserved).toBe(true);
  });

  it('honours an explicit move and reports the source is gone', async () => {
    const { svc } = build();
    const out = await svc.execute(req({ requested: 'move', requireSeeding: false }));
    expect(out.strategy).toBe('move');
    expect(out.sourcePreserved).toBe(false);
  });

  it('creates the destination directory before placing', async () => {
    // The renamer produces a path, not a tree; a first import into a new show
    // folder would otherwise fail with ENOENT.
    const { svc } = build();
    const { mkdir } = jest.requireMock('node:fs/promises');
    await svc.execute(req());
    expect(mkdir).toHaveBeenCalledWith('/media/TV/Show', { recursive: true });
  });

  it('plans without touching anything', async () => {
    const { svc } = build();
    const plan = svc.plan(req());
    expect(plan.strategy).toBe('hardlink');
    expect(placed).toHaveLength(0);
  });
});

describe('provider relocation', () => {
  const relocReq = () => req({ capabilities: caps({ providerRelocation: true }) });

  it('asks the client to move its own data', async () => {
    const { svc, moved } = build({ movesData: true });
    const out = await svc.execute(relocReq());
    expect(out.strategy).toBe('provider_relocation');
    expect(moved).toHaveLength(1);
    expect(placed).toHaveLength(0);
  });

  it('addresses the client in ITS path space, not ours', async () => {
    /*
     * The download client may run in another container with another mount.
     * Handing it our spelling is how a relocation lands somewhere nobody can
     * find — and the torrent keeps seeding from a path that no longer exists.
     */
    const { svc, moved, paths } = build({ movesData: true });
    await svc.execute(relocReq());
    expect(paths.toSpace).toHaveBeenCalledWith('/media/TV/Show', 'provider', 'engine-1');
    expect(moved[0].dest).toBe('/downloads/TV/Show');
  });

  it('refuses relocation on an engine that only moves a pointer', async () => {
    /*
     * rTorrent's d.directory.set moves nothing. Trusting a stale capability row
     * here would point it at an empty directory, so the check is repeated at
     * execution rather than taken on faith from the detector.
     */
    const { svc, moved } = build({ movesData: false });
    const out = await svc.execute(relocReq());
    expect(moved).toHaveLength(0);
    expect(out.strategy).toBe('copy');
    expect(out.fellBack).toBe(true);
    expect(out.reason).toMatch(/does not move data/);
  });

  it('copies rather than failing when the engine is unreachable', async () => {
    // The import still has to happen; a copy always works.
    const { svc } = build({ resolveThrows: true });
    const out = await svc.execute(relocReq());
    expect(out.strategy).toBe('copy');
    expect(out.fellBack).toBe(true);
  });

  it('copies when there is no torrent to relocate', async () => {
    // A manual or watched-folder intake has no hash; relocation is meaningless.
    const { svc } = build({ movesData: true });
    const out = await svc.execute(req({
      capabilities: caps({ providerRelocation: true }), torrentHash: null,
    }));
    expect(out.strategy).toBe('copy');
  });

  it('keeps the source preserved on every relocation path', async () => {
    // Relocation and its fallbacks must all leave something to seed.
    for (const opts of [{ movesData: true }, { movesData: false }, { resolveThrows: true }]) {
      const { svc } = build(opts);
      expect((await svc.execute(relocReq())).sourcePreserved).toBe(true);
    }
  });
});
