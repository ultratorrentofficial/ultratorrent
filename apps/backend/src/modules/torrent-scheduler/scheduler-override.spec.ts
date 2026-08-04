import { BadRequestException } from '@nestjs/common';
import { SchedulerOverrideService } from './scheduler-override.service';
import { planEngine, type PlannerTorrent } from './domain/planner';
import { scoreTorrent } from './domain/priority';
import { UNKNOWN_QUEUE_CAPABILITIES } from './domain/capabilities';
import type { EffectivePolicy } from './domain/policy';

/**
 * Per-torrent overrides.
 *
 * These exist to make capability the planner ALREADY had reachable: it has
 * always honoured protection and force-start, and until now nothing could turn
 * any of them on.
 *
 * The distinction worth testing is `exclude` versus `protect`. A protected
 * torrent is still the scheduler's business — it counts toward limits and can
 * still be resumed — while an excluded one is outside its authority in both
 * directions.
 */
function build(rows: any[] = []) {
  const writes: any[] = [];
  const prisma = {
    torrentSchedulerOverride: {
      findMany: jest.fn(async () => rows),
      upsert: jest.fn(async (a: any) => { writes.push(a); return a; }),
      updateMany: jest.fn(async (a: any) => { writes.push(a); return { count: 1 }; }),
    },
  };
  const registry = {
    get: jest.fn((id: string) => {
      if (id !== 'e1') throw new Error('unknown');
      return { engineId: 'e1', kind: 'qbittorrent' };
    }),
  };
  const audit = { record: jest.fn(async () => undefined) };
  return {
    svc: new SchedulerOverrideService(prisma as never, registry as never, audit as never),
    prisma, writes, audit,
  };
}

const HASH = '44f0ab56d69f5eb9910dd5501b2b548c395fe813';

describe('setting an override', () => {
  it('rejects a kind it does not know', async () => {
    const { svc } = build();
    await expect(svc.set('e1', HASH, { kind: 'do_whatever' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects something that is not an info-hash', async () => {
    // The value reaches a provider call eventually.
    const { svc } = build();
    await expect(svc.set('e1', '../../etc/passwd', { kind: 'exclude' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a nonsensical expiry', async () => {
    const { svc } = build();
    await expect(svc.set('e1', HASH, { kind: 'exclude', expiresInMinutes: 0 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores it lower-cased and audits it', async () => {
    const { svc, writes, audit } = build();
    await svc.set('e1', HASH.toUpperCase(), { kind: 'protect_from_pause' }, 'u1');
    expect(writes[0].create.hash).toBe(HASH);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'torrent_scheduler.override_set' }),
    );
  });

  it('revives a revoked override rather than colliding with it', async () => {
    // Re-applying must clear the revocation; otherwise the unique key would make
    // the second request fail, or leave a cleared row shadowing the new one.
    const { svc, writes } = build();
    await svc.set('e1', HASH, { kind: 'exclude' });
    expect(writes[0].update.clearedAt).toBeNull();
  });

  it('rejects an unknown engine', async () => {
    const { svc } = build();
    await expect(svc.set('nope', HASH, { kind: 'exclude' })).rejects.toThrow();
  });
});

describe('which overrides are in force', () => {
  const now = new Date('2026-08-04T12:00:00Z');

  it('asks the database for unexpired, unrevoked rows', async () => {
    // Expiry is applied at READ time, so a cleanup job that never runs cannot
    // leave an instruction wrongly in force.
    const { svc, prisma } = build([]);
    await svc.active('e1', now);
    const where = (prisma.torrentSchedulerOverride.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.clearedAt).toBeNull();
    expect(where.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: now } }]);
  });

  it('groups several kinds under one torrent', async () => {
    const { svc } = build([
      { hash: HASH, kind: 'exclude' },
      { hash: HASH.toUpperCase(), kind: 'force_start' },
    ]);
    const map = await svc.active('e1', now);
    expect(map.get(HASH)).toEqual(new Set(['exclude', 'force_start']));
  });
});

describe('what an override does to the plan', () => {
  const POLICY: EffectivePolicy = {
    maxConcurrentDownloads: 1, maxConcurrentSeeds: null, maxTotalActive: null,
    maxDownloadRateKbps: null, maxUploadRateKbps: null,
    reserveDownloadBandwidthPercent: null, reserveSeedBandwidthPercent: null,
    seedPolicy: null, activeScheduleId: null, sources: {},
  };
  const CAPS = {
    ...UNKNOWN_QUEUE_CAPABILITIES,
    pause: 'native' as const, resume: 'native' as const, reportsQueuedState: 'native' as const,
  };
  const t = (over: Partial<PlannerTorrent>): PlannerTorrent => ({
    hash: 'h', engineId: 'e1', occupancy: 'download_active', complete: false,
    decision: scoreTorrent({ torrentHash: over.hash ?? 'h', progress: 0.5 }),
    policy: POLICY, addedAt: new Date('2026-01-01T00:00:00Z'),
    lastActionAt: new Date('2026-08-01T00:00:00Z'), ...over,
  });
  const NOW = new Date('2026-08-04T12:00:00Z');

  it('leaves an excluded torrent entirely alone', () => {
    const plan = planEngine('e1', [
      t({ hash: 'a' }), t({ hash: 'x', occupancy: 'excluded' }),
    ], CAPS, { now: NOW });

    const excluded = plan.decisions.find((d) => d.hash === 'x')!;
    expect(excluded.action).toBe('none');
    expect(excluded.reasonCode).toBe('excluded_by_operator');
  });

  it('does not resume an excluded torrent either', () => {
    // Both directions. Protection would still allow a resume; exclusion does not.
    const plan = planEngine('e1', [
      t({ hash: 'x', occupancy: 'excluded' }),
    ], CAPS, { now: NOW });
    expect(plan.decisions[0].action).toBe('none');
  });

  it('keeps a protected torrent running while pausing an unprotected one', () => {
    const plan = planEngine('e1', [
      t({ hash: 'hi', decision: scoreTorrent({ torrentHash: 'hi', progress: 0.9 }) }),
      t({ hash: 'prot', protectedFromPause: true,
         decision: scoreTorrent({ torrentHash: 'prot', progress: 0.1 }) }),
    ], CAPS, { now: NOW });

    expect(plan.decisions.find((d) => d.hash === 'prot')!.action).toBe('none');
  });

  it('force-start beats the limit', () => {
    const plan = planEngine('e1', [
      t({ hash: 'a' }),
      t({ hash: 'f', occupancy: 'scheduler_paused', forceStarted: true,
         decision: scoreTorrent({ torrentHash: 'f', progress: 0, forceStarted: true }) }),
    ], CAPS, { now: NOW });

    expect(plan.decisions.find((d) => d.hash === 'f')!.action).toBe('resume');
  });
});
