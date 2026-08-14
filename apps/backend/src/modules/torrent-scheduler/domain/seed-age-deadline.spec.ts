import { planEngine, type PlannerTorrent } from './planner';
import { scoreTorrent } from './priority';
import { UNKNOWN_QUEUE_CAPABILITIES, type TorrentQueueCapabilities } from './capabilities';
import { evaluateSeedAgeDeadline, type EffectivePolicy, type SeedingPolicy } from './policy';

/**
 * Giving up on a seed target that is never going to be met.
 *
 * The deadline exists because the targets alone cannot end a torrent that stops
 * making progress: a ratio target on a dead swarm sits at `not_met` forever, and
 * an engine that reports no ratio at all leaves it `unknown` forever. Both keep
 * a seed slot occupied indefinitely.
 *
 * Anchored on COMPLETION, not on when the torrent was added — the clock is on
 * the seeding obligation, so a slow download does not spend its deadline before
 * it has seeded a byte.
 */
const NOW = new Date('2026-08-14T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

const CAPS: TorrentQueueCapabilities = {
  ...UNKNOWN_QUEUE_CAPABILITIES,
  pause: 'native', resume: 'native', reportsQueuedState: 'native', ratioReporting: 'native',
};

const seed = (o: Partial<SeedingPolicy>): SeedingPolicy => ({
  mode: 'ratio', afterTarget: 'pause', ...o,
});

const policy = (sp: SeedingPolicy): EffectivePolicy => ({
  maxConcurrentDownloads: null, maxConcurrentSeeds: null, maxTotalActive: null,
  maxDownloadRateKbps: null, maxUploadRateKbps: null,
  reserveDownloadBandwidthPercent: null, reserveSeedBandwidthPercent: null,
  seedPolicy: sp, activeScheduleId: null, sources: {},
});

function seeder(over: Partial<PlannerTorrent> & { seedPolicy: SeedingPolicy }): PlannerTorrent {
  const { seedPolicy, ...rest } = over;
  return {
    hash: 's1', engineId: 'e1', occupancy: 'seed_active', complete: true,
    decision: scoreTorrent({ torrentHash: 's1', progress: 1 }),
    policy: policy(seedPolicy),
    addedAt: daysAgo(90),
    lastActionAt: new Date('2026-08-01T00:00:00Z'),
    ...rest,
  };
}

const only = (t: PlannerTorrent) => planEngine('e1', [t], CAPS, { now: NOW }).decisions[0];

describe('evaluateSeedAgeDeadline', () => {
  it('is not met with no deadline configured', () => {
    expect(evaluateSeedAgeDeadline(seed({}), { completedAt: daysAgo(365) }, NOW)).toBe('not_met');
  });

  it('is met once the torrent has been complete for the configured days', () => {
    const p = seed({ maxAgeDays: 30 });
    expect(evaluateSeedAgeDeadline(p, { completedAt: daysAgo(31) }, NOW)).toBe('met');
    expect(evaluateSeedAgeDeadline(p, { completedAt: daysAgo(30) }, NOW)).toBe('met');
    expect(evaluateSeedAgeDeadline(p, { completedAt: daysAgo(29) }, NOW)).toBe('not_met');
  });

  it('is UNKNOWN, not "within the deadline", when the torrent never completed', () => {
    // The distinction matters: `not_met` would read as "checked, still inside
    // the window" for a torrent whose clock has not started at all.
    expect(evaluateSeedAgeDeadline(seed({ maxAgeDays: 30 }), { completedAt: null }, NOW))
      .toBe('unknown');
    expect(evaluateSeedAgeDeadline(seed({ maxAgeDays: 30 }), {}, NOW)).toBe('unknown');
  });

  it('refuses a non-positive deadline instead of expiring everything at once', () => {
    for (const maxAgeDays of [0, -1]) {
      expect(evaluateSeedAgeDeadline(seed({ maxAgeDays }), { completedAt: daysAgo(365) }, NOW))
        .toBe('not_met');
    }
  });

  it('ignores a completion stamped in the future', () => {
    // Host and engine clocks disagreeing is not an aged torrent.
    expect(evaluateSeedAgeDeadline(
      seed({ maxAgeDays: 30 }), { completedAt: new Date(NOW.getTime() + 5 * DAY) }, NOW,
    )).toBe('not_met');
  });
});

describe('an aged-out seed in the planner', () => {
  it('is removed and cleaned up when the ratio target will not be reached', () => {
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 2, maxAgeDays: 30 }),
      ratio: 0.1,
      completedAt: daysAgo(31),
    }));
    expect(d.action).toBe('remove_and_cleanup');
    expect(d.desiredState).toBe('removed');
    expect(d.reasonCode).toBe('seed_age_deadline_reached');
    expect(d.values).toMatchObject({ maxAgeDays: 30, ratio: 0.1 });
  });

  it('keeps seeding while inside the deadline', () => {
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 2, maxAgeDays: 30 }),
      ratio: 0.1,
      completedAt: daysAgo(10),
    }));
    expect(d.action).toBe('none');
  });

  it('fires even when the ratio cannot be evaluated at all', () => {
    /*
     * The case the deadline is really for. An engine that reports no ratio
     * leaves the target permanently `unknown`, so checking age only on `not_met`
     * would exempt exactly the torrents that can never resolve.
     */
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 2, maxAgeDays: 30 }),
      ratio: undefined,
      completedAt: daysAgo(31),
    }));
    expect(d.action).toBe('remove_and_cleanup');
    expect(d.reasonCode).toBe('seed_age_deadline_reached');
  });

  it('lets a met target win over an expired deadline', () => {
    /*
     * Ordering. A torrent that reached its ratio on day 31 has SUCCEEDED, and
     * must run the operator's chosen `afterTarget` — being one day late does not
     * convert a success into a cleanup.
     */
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 2, maxAgeDays: 30, afterTarget: 'pause' }),
      ratio: 2.5,
      completedAt: daysAgo(31),
    }));
    expect(d.action).toBe('pause');
    expect(d.reasonCode).toBe('seed_target_reached');
  });

  it('overrides an unreachable tracker floor', () => {
    /*
     * `minimumRatio` normally outranks everything — but a floor that the swarm
     * will never satisfy is precisely what pins a torrent forever, and escaping
     * that is the deadline's entire purpose.
     */
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 2, minimumRatio: 1, maxAgeDays: 30 }),
      ratio: 0.05,
      completedAt: daysAgo(60),
    }));
    expect(d.action).toBe('remove_and_cleanup');
  });

  it('never touches a torrent protected from removal', () => {
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 2, maxAgeDays: 30 }),
      ratio: 0.1,
      completedAt: daysAgo(365),
      protectedFromRemoval: true,
    }));
    expect(d.action).not.toBe('remove_and_cleanup');
  });

  it('never ages out a torrent that has not completed', () => {
    // `complete: false` also means it is not a seed at all; belt and braces.
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 2, maxAgeDays: 30 }),
      ratio: 0.1,
      completedAt: null,
      complete: false,
      occupancy: 'download_active',
    }));
    expect(d.action).not.toBe('remove_and_cleanup');
  });

  it('frees the seed slot it was holding for a queued torrent', () => {
    /*
     * A removed torrent must not go on occupying a seed slot for the rest of the
     * sweep. Asserted through the OUTCOME rather than through `summary`, which
     * reports the observed snapshot and so still counts the aged torrent as
     * active whatever the plan plans to do with it.
     *
     * The cap of one is what makes this meaningful: under an unlimited policy the
     * queued torrent would resume regardless, and the test would pass without
     * proving anything.
     */
    const capped = (sp: SeedingPolicy): EffectivePolicy => ({ ...policy(sp), maxConcurrentSeeds: 1 });
    const aged: PlannerTorrent = {
      ...seeder({ hash: 'old', seedPolicy: seed({}), ratio: 0.1, completedAt: daysAgo(60) }),
      policy: capped(seed({ targetRatio: 2, maxAgeDays: 30 })),
    };
    const waiting: PlannerTorrent = {
      ...seeder({ hash: 'new', seedPolicy: seed({}), ratio: 0.5 }),
      occupancy: 'seed_queued',
      decision: scoreTorrent({ torrentHash: 'new', progress: 1 }),
      policy: capped(seed({ targetRatio: 2 })),
    };

    const byHash = Object.fromEntries(
      planEngine('e1', [aged, waiting], CAPS, { now: NOW }).decisions.map((d) => [d.hash, d]),
    );
    expect(byHash.old.action).toBe('remove_and_cleanup');
    expect(byHash.new.action).toBe('resume');
  });
});
