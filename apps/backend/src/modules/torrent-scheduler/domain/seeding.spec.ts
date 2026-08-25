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

  it('removes through the cleanup path when the policy says to', () => {
    /*
     * The planner still does not delete anything itself. It emits
     * `remove_and_cleanup`, which reconciliation hands to the scheduler cleanup
     * service — the same one the age deadline uses, and the same containment
     * rule an operator gets when they remove an intake torrent and keep the
     * library copy: staging files go, library files stay, and the engine is
     * told `removeTorrent` rather than `removeTorrentAndData`.
     *
     * It used to answer `seed_target_removal_not_supported`, so a policy could
     * ask for removal and then quietly do nothing.
     */
    for (const afterTarget of ['remove_torrent_keep_data', 'remove_torrent_and_staging_data'] as const) {
      const d = only(seeder({ seedPolicy: seed({ targetRatio: 1, afterTarget }), ratio: 5 }));
      expect(d.action).toBe('remove_and_cleanup');
      // Distinct from the pause branch's `seed_target_reached`: the rendered
      // sentence for that one says "would stop seeding", which described a
      // deletion as a pause on the review screen.
      expect(d.reasonCode).toBe('seed_target_reached_removed');
    }
  });

  it('carries the torrent name onto the decision, for the operator reviewing it', () => {
    /*
     * Display only — nothing branches on it. It matters because this decision is
     * read by a person deciding whether to enable enforcement, and the review
     * table identified a torrent by a 12-character hash prefix, which is not
     * something anyone can judge "should this be deleted?" against.
     */
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1, afterTarget: 'remove_torrent_and_staging_data' }),
      ratio: 5,
      name: 'Some.Release.2019.1080p',
    }));
    expect(d.name).toBe('Some.Release.2019.1080p');
    expect(d.action).toBe('remove_and_cleanup');
  });

  it('leaves the name undefined when the engine reported none', () => {
    // Absent, never an empty string standing in for a name — the UI falls back
    // to the hash, and "" would render as a blank cell.
    const d = only(seeder({ seedPolicy: seed({ targetRatio: 1 }), ratio: 5 }));
    expect(d.name).toBeUndefined();
  });

  /*
   * The facts that were declared, offered in the builder, and never fed.
   *
   * Failure was fail-safe but silent: an unmeasured fact can never be shown to
   * match, so nothing was deleted for the wrong reason — the policy simply sat
   * there looking configured while governing nothing.
   */
  it('decides a size rule now that sizeBytes is fed', () => {
    const d = only(seeder({
      seedPolicy: seed({
        stopWhen: {
          type: 'all',
          children: [{ type: 'condition', field: 'seed.sizeBytes', operator: 'gte', value: 1000 }],
        },
      }),
      sizeBytes: 5000,
    }));
    expect(d.action).toBe('pause');
    expect(d.reasonCode).toBe('seed_target_reached');
  });

  it('decides a label rule, and answers not_met rather than unknown', () => {
    const d = only(seeder({
      seedPolicy: seed({
        stopWhen: {
          type: 'all',
          children: [{ type: 'condition', field: 'seed.label', operator: 'eq', value: 'archive' }],
        },
      }),
      label: 'keep',
    }));
    // not_met means the rule was READ and answered no — the state that was
    // unreachable while the fact was never populated.
    expect(d.action).toBe('none');
    expect(d.reasonCode).not.toBe('seed_target_unknown');
  });

  it('names the unmeasurable field instead of blaming seed duration', () => {
    /*
     * `no_seed_time_data` was reported for EVERY undecidable target. An operator
     * whose rule asked about the tracker was told the engine does not report
     * seeding time — true, irrelevant, and no help finding the inert rule.
     */
    const plan = planEngine('e1', [seeder({
      seedPolicy: seed({
        stopWhen: {
          type: 'all',
          children: [{ type: 'condition', field: 'seed.tracker', operator: 'contains', value: 'x' }],
        },
      }),
    })], CAPS, { now: NOW });
    const limitation = plan.limitations.find((l) => l.code === 'unmeasurable_seed_condition');
    expect(limitation).toBeDefined();
    expect(limitation?.values?.fields).toBe('seed.tracker');
    expect(plan.decisions[0].reasonCode).toBe('seed_target_unknown');
  });

  it('still blames seed duration when seed duration is what the rule asks for', () => {
    const plan = planEngine('e1', [seeder({
      seedPolicy: seed({
        stopWhen: {
          type: 'all',
          children: [{ type: 'condition', field: 'seed.seedMinutes', operator: 'gte', value: 60 }],
        },
      }),
    })], CAPS, { now: NOW });
    expect(plan.limitations.map((l) => l.code)).toContain('no_seed_time_data');
  });

  it('never removes a torrent the operator protected', () => {
    /*
     * The dangerous ordering. This check sat AFTER the removal branch, so a
     * torrent flagged "never stop automatically" would have been removed and
     * its staging files deleted — the one outcome the flag exists to prevent.
     */
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1, afterTarget: 'remove_torrent_and_staging_data' }),
      ratio: 5,
      protectedFromRemoval: true,
    }));
    expect(d.action).toBe('none');
    expect(d.reasonCode).toBe('protected_from_removal');
  });

  it('still waits for the import before removing anything', () => {
    // Removal is the most destructive outcome, so the import gate matters most
    // here: the staging copy is deleted on the strength of a library copy that
    // must actually exist.
    const d = only(seeder({
      seedPolicy: seed({ targetRatio: 1, afterTarget: 'remove_torrent_and_staging_data', requireImportCompleted: true }),
      ratio: 5,
      intakeImported: false,
    }));
    expect(d.action).toBe('none');
    expect(d.reasonCode).toBe('seed_target_waiting_for_import');
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
