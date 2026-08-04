import { planEngine, type PlannerTorrent } from './planner';
import { scoreTorrent } from './priority';
import { UNKNOWN_QUEUE_CAPABILITIES, type TorrentQueueCapabilities } from './capabilities';
import type { EffectivePolicy, SeedingPolicy } from './policy';

/**
 * Stopping a seed that has met its target.
 *
 * The restraint is the feature. A target that cannot be EVALUATED never stops a
 * torrent, because guessing cuts seeding short or runs it forever; a policy that
 * would take the payload away waits for the import to be real; and the two
 * actions that delete data are refused outright, because acquiring that
 * authority is Media Intake's job and not a queue planner's.
 */
const NOW = new Date('2026-08-04T12:00:00Z');

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
    addedAt: new Date('2026-01-01T00:00:00Z'),
    lastActionAt: new Date('2026-08-01T00:00:00Z'),
    ...rest,
  };
}

const only = (t: PlannerTorrent) => planEngine('e1', [t], CAPS, { now: NOW }).decisions[0];

describe('a seed that met its target', () => {
  it('is paused once the ratio target is reached', () => {
    const d = only(seeder({ seedPolicy: seed({ targetRatio: 2 }), ratio: 2.4 }));
    expect(d.action).toBe('pause');
    expect(d.reasonCode).toBe('seed_target_reached');
  });

  it('keeps seeding while the ratio is short', () => {
    const d = only(seeder({ seedPolicy: seed({ targetRatio: 2 }), ratio: 0.5 }));
    expect(d.action).toBe('none');
    expect(d.reasonCode).toBe('seeding_within_limit');
  });

  it('never stops on a target it cannot evaluate', () => {
    /*
     * Neither shipped engine reports seed duration, so a time target is
     * unknowable. Stopping would cut seeding short; treating it as unmet would
     * seed forever. Reporting it is the only honest option.
     */
    const plan = planEngine('e1', [
      seeder({ seedPolicy: seed({ mode: 'time', targetSeedMinutes: 60 }), ratio: 9 }),
    ], CAPS, { now: NOW });

    expect(plan.decisions[0].action).toBe('none');
    expect(plan.decisions[0].reasonCode).toBe('seed_target_unknown');
    expect(plan.limitations.map((l) => l.code)).toContain('no_seed_time_data');
  });

  it('waits for the import before acting on the target', () => {
    // The usual reason to seed past completion is that the library copy is not
    // safe yet; acting before the import lands would defeat the point.
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1, requireImportCompleted: true }),
      ratio: 5, intakeImported: false,
    }));
    expect(d.action).toBe('none');
    expect(d.reasonCode).toBe('seed_target_waiting_for_import');
  });

  it('acts once the import has completed', () => {
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1, requireImportCompleted: true }),
      ratio: 5, intakeImported: true,
    }));
    expect(d.action).toBe('pause');
  });

  it('waits for the library copy when the policy demands it', () => {
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1, requireLibraryCopyVerified: true }),
      ratio: 5, intakeImported: true, libraryCopyVerified: false,
    }));
    expect(d.reasonCode).toBe('seed_target_waiting_for_library_copy');
  });

  it('refuses to remove a torrent, however the policy is written', () => {
    /*
     * Removing a payload has to pass Media Intake's ownership and path-safety
     * checks. A queue planner is the wrong place to acquire that authority, so
     * the action is declined visibly rather than performed carelessly.
     */
    for (const afterTarget of ['remove_torrent_keep_data', 'remove_torrent_and_staging_data'] as const) {
      const d = only(seeder({ seedPolicy: seed({ targetRatio: 1, afterTarget }), ratio: 5 }));
      expect(d.action).toBe('none');
      expect(d.reasonCode).toBe('seed_target_removal_not_supported');
    }
  });

  it('leaves it running when the policy says to', () => {
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1, afterTarget: 'leave_active' }), ratio: 5,
    }));
    expect(d.action).toBe('none');
    expect(d.reasonCode).toBe('seed_target_reached_left_active');
  });

  it('respects protection from removal', () => {
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1 }), ratio: 5, protectedFromRemoval: true,
    }));
    expect(d.action).toBe('none');
    expect(d.reasonCode).toBe('protected_from_removal');
  });

  it('respects protection from pausing before the target is even considered', () => {
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1 }), ratio: 5, protectedFromPause: true,
    }));
    expect(d.action).toBe('none');
  });

  it('honours a minimum obligation over a met target', () => {
    // Minimum seed time is unmeasurable here, so the obligation is unknowable
    // and the torrent keeps seeding rather than being stopped on a guess.
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1, minimumSeedMinutes: 120 }), ratio: 9,
    }));
    expect(d.action).toBe('none');
    expect(d.reasonCode).toBe('seed_target_unknown');
  });

  it('never auto-stops a manual or unlimited policy', () => {
    for (const mode of ['manual', 'unlimited'] as const) {
      const d = only(seeder({ seedPolicy: seed({ mode, targetRatio: 1 }), ratio: 99 }));
      expect(d.action).toBe('none');
    }
  });

  it('does not touch a downloading torrent', () => {
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1 }), ratio: 5,
      complete: false, occupancy: 'download_active',
    }));
    expect(d.action).toBe('none');
    expect(d.reasonCode).toBe('downloading_within_limit');
  });
});
