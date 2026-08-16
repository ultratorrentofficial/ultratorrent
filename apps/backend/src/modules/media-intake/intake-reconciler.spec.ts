import { IntakeReconcilerService } from './intake-reconciler.service';

/**
 * `seeding -> archived` is a transition the pipeline defines and nothing ever
 * performed, so `seeding` was terminal in practice — 64 of 146 such jobs across
 * two live hosts named torrents that no longer existed. Everything downstream
 * reads `state` to decide whether something is still seeding, so all of them
 * inherited that.
 */
function build(jobs: unknown[], engine: unknown) {
  const transitions: Array<{ id: string; to: string }> = [];
  const prisma = { mediaIntakeJob: { findMany: jest.fn(async () => jobs) } };
  const intake = {
    transition: jest.fn(async (id: string, to: string) => { transitions.push({ id, to }); }),
  };
  const moduleRef = { get: jest.fn(() => engine) };
  const svc = new IntakeReconcilerService(prisma as never, intake as never, moduleRef as never);
  return { svc, transitions, intake };
}
const listing = (hashes: string[]) => ({ list: jest.fn(async () => ({ items: hashes.map((h) => ({ hash: h })) })) });

describe('IntakeReconcilerService', () => {
  it('archives a job whose torrent the engine no longer has', async () => {
    const { svc, transitions } = build(
      [{ id: 'j1', torrentHash: 'GONE', sourcePath: '/i/a' }],
      listing(['other']),
    );

    expect(await svc.reconcile()).toBe(1);
    expect(transitions).toEqual([{ id: 'j1', to: 'archived' }]);
  });

  it('leaves a job whose torrent is still there', async () => {
    const { svc, transitions } = build(
      [{ id: 'j1', torrentHash: 'ABC', sourcePath: '/i/a' }],
      listing(['abc']),   // case-insensitive
    );

    expect(await svc.reconcile()).toBe(0);
    expect(transitions).toEqual([]);
  });

  it('refuses to act when the engine cannot be read', async () => {
    /*
     * The dangerous case. An unreachable engine returns nothing, which is
     * indistinguishable from "no torrents at all" — and acting on it would
     * archive every intake in a single sweep.
     */
    const { svc, transitions } = build(
      [{ id: 'j1', torrentHash: 'ABC', sourcePath: '/i/a' }],
      { list: jest.fn(async () => { throw new Error('engine down'); }) },
    );

    expect(await svc.reconcile()).toBe(0);
    expect(transitions).toEqual([]);
  });

  it('refuses when the engine returns a shape it cannot read', async () => {
    const { svc, transitions } = build(
      [{ id: 'j1', torrentHash: 'ABC', sourcePath: '/i/a' }],
      { list: jest.fn(async () => ({ nope: true })) },
    );

    expect(await svc.reconcile()).toBe(0);
    expect(transitions).toEqual([]);
  });

  it('archives nothing when the engine genuinely holds no torrents but says so', async () => {
    // An empty ITEMS array is a real answer, unlike a failure — so it acts.
    const { svc, transitions } = build(
      [{ id: 'j1', torrentHash: 'ABC', sourcePath: '/i/a' }],
      listing([]),
    );

    expect(await svc.reconcile()).toBe(1);
    expect(transitions).toEqual([{ id: 'j1', to: 'archived' }]);
  });

  it('skips a job with no recorded hash rather than guessing', async () => {
    const { svc, transitions } = build(
      [{ id: 'j1', torrentHash: null, sourcePath: '/i/a' }],
      listing(['abc']),
    );

    expect(await svc.reconcile()).toBe(0);
    expect(transitions).toEqual([]);
  });

  it('keeps going when one transition is refused', async () => {
    const { svc } = build(
      [{ id: 'j1', torrentHash: 'x', sourcePath: '/i/a' }, { id: 'j2', torrentHash: 'y', sourcePath: '/i/b' }],
      listing([]),
    );
    // A job may have moved on since the query; that is a fact, not a crash.
    (svc as never as { intake: unknown });
    expect(await svc.reconcile()).toBe(2);
  });
});
