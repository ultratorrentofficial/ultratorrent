import { TorrentState } from '@ultratorrent/shared';
import { SchedulerReconciliationService } from './scheduler-reconciliation.service';
import type { EngineActivityPlan, TorrentDecision } from './domain/planner';

/**
 * Applying a plan.
 *
 * This is the first scheduler code that can change a torrent, so the tests are
 * about restraint rather than throughput: slots are freed before they are
 * claimed, a provider's silence is not taken as success, and one failure never
 * costs the rest of the plan.
 *
 * Nothing reaches this service yet — the sweep calls it only for `managed` mode
 * and that mode is refused — but it is tested as if it were live, because the
 * phase that enables it should not also be the phase that first exercises it.
 */
const decision = (hash: string, action: 'pause' | 'resume' | 'none'): TorrentDecision => ({
  hash, engineId: 'e1', currentOccupancy: 'download_active',
  desiredState: action === 'pause' ? 'paused' : 'active',
  action, reasonCode: 'x', messageKey: 'x', score: 0, protectedFromPause: false,
});

const plan = (decisions: TorrentDecision[]): EngineActivityPlan => ({
  engineId: 'e1', decisions,
  summary: { activeDownloads: 0, activeSeeds: 0, totalActive: 0, queuedDownloads: 0, queuedSeeds: 0 },
  limitations: [],
});

function providerStub(states: Record<string, TorrentState> = {}) {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      pauseTorrent: jest.fn(async (h: string) => { calls.push(`pause:${h}`); }),
      resumeTorrent: jest.fn(async (h: string) => { calls.push(`resume:${h}`); }),
      getTorrent: jest.fn(async (h: string) =>
        states[h] === undefined ? null : { hash: h, state: states[h] }),
    } as any,
  };
}

const noSleep = async () => undefined;

describe('applying a plan', () => {
  // Records which torrents the scheduler itself paused, so a later sweep can
  // tell its own work apart from a person's and give the slot back.
  const remembered: any[] = [];
  const prisma = {
    torrentSchedulerState: {
      upsert: jest.fn(async (a: any) => { remembered.push(a); return a; }),
    },
  };
  const svc = new SchedulerReconciliationService(prisma as never);
  beforeEach(() => { remembered.length = 0; });

  it('pauses before it resumes', async () => {
    // Resuming first would momentarily exceed the limit being enforced, and on
    // an engine with its own queue the resumed torrent would just be refused.
    const { provider, calls } = providerStub({
      p1: TorrentState.PAUSED, r1: TorrentState.DOWNLOADING,
    });
    await svc.apply(plan([decision('r1', 'resume'), decision('p1', 'pause')]), provider, { sleep: noSleep });

    expect(calls).toEqual(['pause:p1', 'resume:r1']);
  });

  it('only touches torrents the plan asked about', async () => {
    const { provider, calls } = providerStub({ a: TorrentState.PAUSED });
    await svc.apply(
      plan([decision('a', 'pause'), decision('b', 'none'), decision('c', 'none')]),
      provider, { sleep: noSleep },
    );
    expect(calls).toEqual(['pause:a']);
  });

  it('does not trust a provider that accepted the call but did nothing', async () => {
    // The call returned without throwing and the torrent is still downloading.
    const { provider } = providerStub({ a: TorrentState.DOWNLOADING });
    const out = await svc.apply(plan([decision('a', 'pause')]), provider, { sleep: noSleep });

    expect(out.applied).toBe(0);
    expect(out.unverified).toBe(1);
  });

  it('reports a resume the engine queued as a native queue conflict', async () => {
    /*
     * The subtle one, and the reason verification exists at all. The provider
     * documents it: "a plain resume on a full queue lands it in `queued`". The
     * call succeeded, the torrent is not running, and the engine's own limits
     * are the reason — telling the operator we applied it would claim control we
     * do not have.
     */
    const { provider } = providerStub({ a: TorrentState.QUEUED });
    const out = await svc.apply(plan([decision('a', 'resume')]), provider, { sleep: noSleep });

    expect(out.applied).toBe(0);
    expect(out.unverified).toBe(1);
    expect(out.limitations.map((l) => l.code)).toContain('native_queue_conflict');
  });

  it('raises the conflict once, however many torrents hit it', async () => {
    const { provider } = providerStub({
      a: TorrentState.QUEUED, b: TorrentState.QUEUED, c: TorrentState.QUEUED,
    });
    const out = await svc.apply(
      plan([decision('a', 'resume'), decision('b', 'resume'), decision('c', 'resume')]),
      provider, { sleep: noSleep },
    );
    expect(out.unverified).toBe(3);
    expect(out.limitations).toHaveLength(1);
  });

  it('counts a torrent that vanished mid-plan as done, not failed', async () => {
    // Someone deleted it while the plan was being applied. The desired end state
    // for a pause is "not occupying a slot", and a torrent that no longer exists
    // satisfies it; alarming here would fire on an ordinary deletion.
    const { provider } = providerStub({});
    const out = await svc.apply(plan([decision('gone', 'pause')]), provider, { sleep: noSleep });

    expect(out.applied).toBe(1);
    expect(out.failed).toBe(0);
  });

  it('keeps going after one torrent fails', async () => {
    const { provider } = providerStub({ b: TorrentState.PAUSED, c: TorrentState.PAUSED });
    (provider.pauseTorrent as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('403 from engine');
    });

    const out = await svc.apply(
      plan([decision('a', 'pause'), decision('b', 'pause'), decision('c', 'pause')]),
      provider, { sleep: noSleep },
    );

    expect(out.attempted).toBe(3);
    expect(out.failed).toBe(1);
    expect(out.applied).toBe(2);
    expect(out.failures[0]).toMatchObject({ hash: 'a', action: 'pause' });
  });

  it('records why a failure happened rather than only that it did', async () => {
    const { provider } = providerStub({});
    (provider.resumeTorrent as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('engine offline');
    });
    const out = await svc.apply(plan([decision('a', 'resume')]), provider, { sleep: noSleep });

    expect(out.failures[0].error).toBe('engine offline');
  });

  it('treats checking as a successful resume', async () => {
    // A resumed torrent that goes straight to verifying IS running; demanding
    // `downloading` would report a false failure on every recheck-on-resume.
    const { provider } = providerStub({ a: TorrentState.CHECKING });
    const out = await svc.apply(plan([decision('a', 'resume')]), provider, { sleep: noSleep });
    expect(out.applied).toBe(1);
  });

  it('accepts stopped as a successful pause', async () => {
    // rTorrent stops rather than pauses; both satisfy "not occupying a slot".
    const { provider } = providerStub({ a: TorrentState.STOPPED });
    const out = await svc.apply(plan([decision('a', 'pause')]), provider, { sleep: noSleep });
    expect(out.applied).toBe(1);
  });

  it('records its own pause so the slot can be given back later', async () => {
    // Without this the next sweep sees an ordinary paused torrent, cannot tell
    // it was ours, and never resumes it — enforcement in one direction only.
    const { provider } = providerStub({ a: TorrentState.PAUSED });
    await svc.apply(plan([decision('a', 'pause')]), provider, { sleep: noSleep });

    expect(remembered).toHaveLength(1);
    expect(remembered[0].create.schedulerPausedAt).toBeInstanceOf(Date);
  });

  it('clears the claim when it resumes the torrent again', async () => {
    const { provider } = providerStub({ a: TorrentState.DOWNLOADING });
    await svc.apply(plan([decision('a', 'resume')]), provider, { sleep: noSleep });

    expect(remembered[0].update.schedulerPausedAt).toBeNull();
  });

  it('claims nothing when the pause could not be confirmed', async () => {
    // A row claiming we paused something we failed to pause would let a later
    // sweep resume a torrent a person had stopped.
    const { provider } = providerStub({ a: TorrentState.DOWNLOADING });
    await svc.apply(plan([decision('a', 'pause')]), provider, { sleep: noSleep });

    expect(remembered).toHaveLength(0);
  });

  it('can skip verification when the caller does not want the round trip', async () => {
    const { provider } = providerStub({ a: TorrentState.DOWNLOADING });
    const out = await svc.apply(
      plan([decision('a', 'pause')]), provider, { verify: false, sleep: noSleep },
    );
    expect(out.applied).toBe(1);
    expect(provider.getTorrent).not.toHaveBeenCalled();
  });
});
