import { TorrentState } from '@ultratorrent/shared';
import { planEngine, type PlannerTorrent } from './planner';
import { classify } from './classification';
import { scoreTorrent, orderByPriority } from './priority';
import { UNKNOWN_QUEUE_CAPABILITIES, type TorrentQueueCapabilities } from './capabilities';
import type { EffectivePolicy } from './policy';

/**
 * The planner decides what SHOULD run. It touches nothing.
 *
 * These pin the properties that make enforcement safe to switch on later: a
 * user's pause is never undone, protection beats a limit, the three limits are
 * independent, and an equally-ranked pair does not swap places every sweep.
 * Observe Only runs this same function, so what an operator validates there is
 * exactly what enforcement would do.
 */
const NOW = new Date('2026-08-04T12:00:00Z');

const CAPS: TorrentQueueCapabilities = {
  ...UNKNOWN_QUEUE_CAPABILITIES,
  pause: 'native', resume: 'native', reportsQueuedState: 'native',
  activeDownloadLimit: 'native', activeSeedLimit: 'native', totalActiveLimit: 'native',
  ratioReporting: 'native', nativeQueueModel: 'separate-download-seed',
};

const POLICY = (over: Partial<EffectivePolicy> = {}): EffectivePolicy => ({
  maxConcurrentDownloads: null, maxConcurrentSeeds: null, maxTotalActive: null,
  maxDownloadRateKbps: null, maxUploadRateKbps: null,
  reserveDownloadBandwidthPercent: null, reserveSeedBandwidthPercent: null,
  seedPolicy: null, activeScheduleId: null, sources: {}, ...over,
});

let seq = 0;
function t(over: Partial<PlannerTorrent> & { hash?: string } = {}): PlannerTorrent {
  const hash = over.hash ?? `h${++seq}`;
  return {
    hash, engineId: 'e1',
    occupancy: 'download_active',
    decision: scoreTorrent({ torrentHash: hash, progress: 0.5 }),
    policy: POLICY(),
    complete: false,
    addedAt: new Date('2026-01-01T00:00:00Z'),
    lastActionAt: new Date('2026-08-04T00:00:00Z'), // long ago: hysteresis clear
    ...over,
  };
}

const byHash = (plan: ReturnType<typeof planEngine>, hash: string) =>
  plan.decisions.find((d) => d.hash === hash)!;

describe('planEngine — limits', () => {
  it('pauses the excess when the download limit is exceeded', () => {
    const pol = POLICY({ maxConcurrentDownloads: 2 });
    const torrents = [1, 2, 3].map((i) => t({ hash: `d${i}`, policy: pol }));
    const plan = planEngine('e1', torrents, CAPS, { now: NOW });

    expect(plan.decisions.filter((d) => d.action === 'pause')).toHaveLength(1);
    expect(plan.summary.activeDownloads).toBe(2);
  });

  it('counts seeds against their own limit, not the download limit', () => {
    const pol = POLICY({ maxConcurrentDownloads: 1, maxConcurrentSeeds: 2 });
    const plan = planEngine('e1', [
      t({ hash: 'd1', policy: pol }),
      t({ hash: 's1', policy: pol, occupancy: 'seed_active', complete: true }),
      t({ hash: 's2', policy: pol, occupancy: 'seed_active', complete: true }),
    ], CAPS, { now: NOW });

    expect(plan.decisions.filter((d) => d.action === 'pause')).toHaveLength(0);
    expect(plan.summary.activeDownloads).toBe(1);
    expect(plan.summary.activeSeeds).toBe(2);
  });

  it('enforces the total-active limit independently of the other two', () => {
    // Downloads and seeds are each within their own cap; only the total is not.
    const pol = POLICY({ maxConcurrentDownloads: 5, maxConcurrentSeeds: 5, maxTotalActive: 2 });
    const plan = planEngine('e1', [
      t({ hash: 'd1', policy: pol, decision: scoreTorrent({ torrentHash: 'd1', progress: 0.9 }) }),
      t({ hash: 'd2', policy: pol, decision: scoreTorrent({ torrentHash: 'd2', progress: 0.8 }) }),
      t({ hash: 's1', policy: pol, occupancy: 'seed_active', complete: true,
         decision: scoreTorrent({ torrentHash: 's1', progress: 1 }) }),
    ], CAPS, { now: NOW });

    expect(plan.summary.totalActive).toBe(2);
    expect(plan.decisions.filter((d) => d.action === 'pause')).toHaveLength(1);
  });

  it('treats a null limit as unlimited', () => {
    const torrents = Array.from({ length: 50 }, (_, i) => t({ hash: `x${i}` }));
    const plan = planEngine('e1', torrents, CAPS, { now: NOW });
    expect(plan.decisions.filter((d) => d.action === 'pause')).toHaveLength(0);
    expect(plan.summary.activeDownloads).toBe(50);
  });

  it('resumes a queued torrent into a free slot', () => {
    const pol = POLICY({ maxConcurrentDownloads: 2 });
    const plan = planEngine('e1', [
      t({ hash: 'a', policy: pol }),
      t({ hash: 'q', policy: pol, occupancy: 'download_queued' }),
    ], CAPS, { now: NOW });

    expect(byHash(plan, 'q').action).toBe('resume');
  });

  it('reports why a torrent is waiting rather than leaving it unexplained', () => {
    const pol = POLICY({ maxConcurrentDownloads: 1 });
    const plan = planEngine('e1', [
      t({ hash: 'a', policy: pol }),
      t({ hash: 'q', policy: pol, occupancy: 'download_queued' }),
    ], CAPS, { now: NOW });

    const waiting = byHash(plan, 'q');
    expect(waiting.action).toBe('none');
    expect(waiting.reasonCode).toBe('waiting_for_download_slot');
    expect(waiting.values).toEqual({ limit: 1 });
    expect(plan.summary.queuedDownloads).toBe(1);
  });
});

describe('planEngine — what it must never touch', () => {
  it('never resumes a torrent a person paused', () => {
    // The single most important property: a human decision outranks the planner.
    const plan = planEngine('e1', [
      t({ hash: 'u', occupancy: 'user_paused', policy: POLICY({ maxConcurrentDownloads: 10 }) }),
    ], CAPS, { now: NOW });

    expect(byHash(plan, 'u').action).toBe('none');
    expect(byHash(plan, 'u').reasonCode).toBe('paused_by_user');
  });

  it('never resumes a torrent paused outside the scheduler', () => {
    const plan = planEngine('e1', [
      t({ hash: 'p', occupancy: 'provider_paused', policy: POLICY({ maxConcurrentDownloads: 10 }) }),
    ], CAPS, { now: NOW });
    expect(byHash(plan, 'p').action).toBe('none');
  });

  it('leaves a parked torrent to the parking service', () => {
    // Coexistence: parking owns the dead-swarm reason. Two schedulers resuming
    // and re-pausing the same torrent is the failure this avoids.
    const plan = planEngine('e1', [
      t({ hash: 'k', occupancy: 'parked', policy: POLICY({ maxConcurrentDownloads: 10 }) }),
    ], CAPS, { now: NOW });
    expect(byHash(plan, 'k').action).toBe('none');
    expect(byHash(plan, 'k').reasonCode).toBe('parked_dead_swarm');
  });

  it('never pauses a protected torrent, even over the limit', () => {
    const pol = POLICY({ maxConcurrentDownloads: 1 });
    const plan = planEngine('e1', [
      t({ hash: 'lo', policy: pol, decision: scoreTorrent({ torrentHash: 'lo', progress: 0.9 }) }),
      t({ hash: 'prot', policy: pol, protectedFromPause: true,
         decision: scoreTorrent({ torrentHash: 'prot', progress: 0.1 }) }),
    ], CAPS, { now: NOW });

    expect(byHash(plan, 'prot').action).toBe('none');
    expect(byHash(plan, 'prot').reasonCode).toBe('protected_from_pause');
  });

  it('does not act on a torrent in an unknown state', () => {
    const plan = planEngine('e1', [t({ hash: 'x', occupancy: 'unknown' })], CAPS, { now: NOW });
    expect(byHash(plan, 'x').action).toBe('none');
  });

  it('plans nothing at all for an engine that cannot pause', () => {
    const caps = { ...CAPS, pause: 'unsupported' as const };
    const plan = planEngine('e1', [t({ hash: 'a' }), t({ hash: 'b' })], caps, { now: NOW });

    expect(plan.decisions.every((d) => d.action === 'none')).toBe(true);
    expect(plan.limitations.map((l) => l.code)).toContain('no_pause_support');
  });
});

describe('planEngine — churn control', () => {
  it('does not pause a torrent the scheduler only just started', () => {
    const pol = POLICY({ maxConcurrentDownloads: 1 });
    const plan = planEngine('e1', [
      t({ hash: 'old', policy: pol, decision: scoreTorrent({ torrentHash: 'old', progress: 0.9 }) }),
      t({ hash: 'new', policy: pol, lastActionAt: new Date(NOW.getTime() - 5_000),
         decision: scoreTorrent({ torrentHash: 'new', progress: 0.1 }) }),
    ], CAPS, { now: NOW, minimumActiveSeconds: 120 });

    expect(byHash(plan, 'new').action).toBe('none');
    expect(byHash(plan, 'new').reasonCode).toBe('too_recently_started');
  });

  it('bounds the number of changes per sweep', () => {
    const pol = POLICY({ maxConcurrentDownloads: 1 });
    const torrents = Array.from({ length: 10 }, (_, i) => t({ hash: `d${i}`, policy: pol }));
    const plan = planEngine('e1', torrents, CAPS, { now: NOW, maxActionsPerSweep: 3 });

    expect(plan.decisions.filter((d) => d.action !== 'none').length).toBeLessThanOrEqual(3);
    expect(plan.decisions.some((d) => d.reasonCode === 'action_budget_exhausted')).toBe(true);
  });

  it('force-start wins a slot regardless of the limit, and says so', () => {
    const pol = POLICY({ maxConcurrentDownloads: 1 });
    const plan = planEngine('e1', [
      t({ hash: 'a', policy: pol }),
      t({ hash: 'f', policy: pol, occupancy: 'scheduler_paused', forceStarted: true,
         decision: scoreTorrent({ torrentHash: 'f', progress: 0, forceStarted: true }) }),
    ], CAPS, { now: NOW });

    expect(byHash(plan, 'f').action).toBe('resume');
    expect(byHash(plan, 'f').reasonCode).toBe('force_started_resume');
  });
});

describe('ordering determinism', () => {
  it('keeps an incumbent ahead of a challenger at equal score', () => {
    // The anti-churn tie-break. Without it two equal torrents swap every sweep.
    const mk = (hash: string, currentlyActive: boolean) => ({
      decision: scoreTorrent({ torrentHash: hash, progress: 0.5 }),
      currentlyActive, addedAt: new Date('2026-01-01T00:00:00Z'),
    });
    const ordered = orderByPriority([mk('bbb', false), mk('aaa', true)]);
    expect(ordered[0].decision.torrentHash).toBe('aaa');
  });

  it('is stable for identical inputs in any order', () => {
    const mk = (hash: string) => ({
      decision: scoreTorrent({ torrentHash: hash, progress: 0.5 }),
      currentlyActive: false, addedAt: null,
    });
    const a = orderByPriority([mk('c'), mk('a'), mk('b')]).map((x) => x.decision.torrentHash);
    const b = orderByPriority([mk('b'), mk('c'), mk('a')]).map((x) => x.decision.torrentHash);
    expect(a).toEqual(b);
    expect(a).toEqual(['a', 'b', 'c']);
  });
});

describe('classification honesty', () => {
  it('marks occupancy inferred when the engine cannot report a queued state', () => {
    // rTorrent: a torrent waiting for a slot reports as DOWNLOADING.
    const caps = { ...CAPS, reportsQueuedState: 'unsupported' as const };
    const c = classify(
      { state: TorrentState.DOWNLOADING, progress: 0.2, downloadRate: 0, uploadRate: 0 }, caps,
    );
    expect(c.occupancy).toBe('download_active');
    expect(c.confidence).toBe('inferred');
    expect(c.reasonCode).toBe('active_or_queued_indistinguishable');
  });

  it('counts a seed with no leechers as occupying a seed slot', () => {
    const c = classify(
      { state: TorrentState.SEEDING, progress: 1, downloadRate: 0, uploadRate: 0 }, CAPS,
    );
    expect(c.occupancy).toBe('seed_active');
  });

  it('separates a user pause from a scheduler pause', () => {
    const base = { state: TorrentState.PAUSED, progress: 0.5, downloadRate: 0, uploadRate: 0 };
    expect(classify({ ...base, userPaused: true }, CAPS).occupancy).toBe('user_paused');
    expect(classify({ ...base, schedulerPaused: true }, CAPS).occupancy).toBe('scheduler_paused');
    // Neither claims it: not ours to resume.
    expect(classify(base, CAPS).occupancy).toBe('provider_paused');
  });
});
