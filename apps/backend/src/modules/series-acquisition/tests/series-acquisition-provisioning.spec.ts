import { BadRequestException } from '@nestjs/common';

import {
  SeriesAcquisitionProvisioningService,
  type SeriesAcquisitionInput,
} from '../series-acquisition-provisioning.service';

/**
 * The Add-Series orchestrator, exercised against hand-rolled fakes of the
 * subsystems it composes. The assertions are about the CONTRACT between modes
 * and subsystems — which rule gets enabled, when a backfill is enqueued, what
 * counts as out-of-scope — not about any subsystem's internals.
 */

const TEMPLATE = {
  id: 'dt1',
  name: 'Premium TV',
  acquisitionTemplateId: 'acq1',
  pathTemplate: 'TV Shows/{tvshow} ({year})',
  storageProfileId: 'sp1',
  rssFeedId: 'feed1',
};

const PROFILE = {
  id: 'sp1',
  stagingRoot: '/downloads/Staging',
  movieLibraryId: null,
  tvLibraryId: 'tv1',
  movieLibrary: null,
  tvLibrary: { path: '/media/TV' },
};

function harness(
  opts: {
    template?: unknown;
    readiness?: { ready: boolean; reason: string };
    existing?: { id: string; status: string; rssRuleId: string | null } | null;
    status?: string; // normalized show status from lookup
    statusThrows?: boolean;
    linkOutcome?: 'created' | 'updated' | 'unchanged';
    generateResult?: { ruleId: string | null; outcome: string; reason?: string };
    ruleStillOurs?: boolean; // updateMany count
    scan?: { missing: number } | null;
    scanThrows?: boolean;
    excludedCount?: number;
  } = {},
) {
  const calls = {
    linkOrCreate: [] as Array<{ target: Record<string, unknown> }>,
    rssRuleUpdateMany: [] as Array<Record<string, unknown>>,
    wantedUpdateMany: [] as Array<Record<string, unknown>>,
    backfillEnqueue: [] as Array<Record<string, unknown>>,
    audit: [] as Array<Record<string, unknown>>,
  };

  const prisma: any = {
    discoveryTemplate: {
      findFirst: jest.fn().mockResolvedValue(opts.template === undefined ? TEMPLATE : opts.template),
      findUnique: jest.fn().mockResolvedValue(opts.template === undefined ? TEMPLATE : opts.template),
    },
    storageProfile: { findUnique: jest.fn().mockResolvedValue(PROFILE) },
    acquisitionRuleTemplate: { findUnique: jest.fn().mockResolvedValue({ id: 'acq1', candidates: [] }) },
    rssRule: {
      updateMany: jest.fn(async (args: any) => {
        calls.rssRuleUpdateMany.push(args);
        return { count: opts.ruleStillOurs === false ? 0 : 1 };
      }),
      findUnique: jest.fn().mockResolvedValue({ isEnabled: true }),
    },
    wantedEpisode: {
      updateMany: jest.fn(async (args: any) => {
        calls.wantedUpdateMany.push(args);
        return { count: 0 };
      }),
      count: jest.fn().mockResolvedValue(opts.excludedCount ?? 0),
    },
  };

  const watchlist: any = {
    resolveExisting: jest.fn().mockResolvedValue(opts.existing ?? null),
    linkOrCreate: jest.fn(async (_media: unknown, target: Record<string, unknown> = {}) => {
      calls.linkOrCreate.push({ target });
      // The first call (full target) creates; the rule-attach call is a no-op update.
      if (target.rssRuleId) return { watchlistItemId: 'wl1', outcome: 'updated' };
      return { watchlistItemId: 'wl1', outcome: opts.linkOutcome ?? 'created' };
    }),
  };
  const rules: any = {
    generate: jest.fn().mockResolvedValue(
      opts.generateResult ?? { ruleId: 'rule1', outcome: 'created' },
    ),
  };
  const templates: any = {
    acquisitionReadiness: jest.fn().mockResolvedValue(opts.readiness ?? { ready: true, reason: 'ok' }),
  };
  const intake: any = { provision: jest.fn().mockResolvedValue({ ok: true, detail: 'created' }) };
  const missingEpisodes: any = {
    scanSeries: jest.fn(async () => {
      if (opts.scanThrows) throw new Error('no imdb id');
      const missing = opts.scan === null ? 0 : opts.scan?.missing ?? 3;
      return {
        watchlistItemId: 'wl1',
        title: 'Show',
        seriesTconst: 'tt100',
        total: 10,
        owned: 10 - missing,
        missing,
        unaired: 0,
        ignored: 0,
        lastCheckedAt: new Date(),
      };
    }),
  };
  const showStatus: any = {
    lookup: jest.fn(async () => {
      if (opts.statusThrows) throw new Error('no provider');
      return { normalizedStatus: opts.status ?? 'returning' };
    }),
  };
  const backfill: any = {
    enqueue: jest.fn(async (input: Record<string, unknown>) => {
      calls.backfillEnqueue.push(input);
      return { jobId: 'job1' };
    }),
  };
  const audit: any = { record: jest.fn(async (a: Record<string, unknown>) => void calls.audit.push(a)) };
  const realtime: any = { broadcast: jest.fn() };

  const svc = new SeriesAcquisitionProvisioningService(
    prisma,
    audit,
    watchlist,
    rules,
    templates,
    intake,
    missingEpisodes,
    showStatus,
    backfill,
    realtime,
  );
  return { svc, calls, prisma, watchlist, rules, backfill };
}

const base: SeriesAcquisitionInput = {
  title: 'The Expanse',
  year: 2015,
  externalIds: { imdb: 'tt3230854' },
  mode: 'backfill_and_monitor',
};

describe('SeriesAcquisitionProvisioningService', () => {
  it('refuses when match preferences are not ready', async () => {
    const { svc } = harness({ readiness: { ready: false, reason: 'no enabled candidates' } });
    await expect(svc.provisionSeriesAcquisition(base)).rejects.toThrow(BadRequestException);
  });

  it('refuses when no template carries a feed + storage profile', async () => {
    const { svc } = harness({ template: null });
    await expect(svc.provisionSeriesAcquisition(base)).rejects.toThrow(/no discovery template/i);
  });

  it('backfill_and_monitor: rule enabled and a backfill is enqueued', async () => {
    const { svc, calls } = harness({ scan: { missing: 4 } });
    const res = await svc.provisionSeriesAcquisition(base);
    expect(res.ruleEnabled).toBe(true);
    expect(calls.rssRuleUpdateMany[0].data).toMatchObject({ isEnabled: true });
    expect(res.backfillJobId).toBe('job1');
    expect(calls.backfillEnqueue).toHaveLength(1);
  });

  it('backfill_only: rule disabled but a backfill still runs', async () => {
    const { svc, calls } = harness({ scan: { missing: 4 } });
    const res = await svc.provisionSeriesAcquisition({ ...base, mode: 'backfill_only' });
    expect(res.ruleEnabled).toBe(false);
    expect(calls.rssRuleUpdateMany[0].data).toMatchObject({ isEnabled: false });
    expect(res.backfillJobId).toBe('job1');
  });

  it('monitor_new_only: rule enabled, NO backfill, aired-missing marked out of scope', async () => {
    const { svc, calls } = harness({ scan: { missing: 4 } });
    const res = await svc.provisionSeriesAcquisition({ ...base, mode: 'monitor_new_only' });
    expect(res.ruleEnabled).toBe(true);
    expect(res.backfillJobId).toBeNull();
    expect(calls.backfillEnqueue).toHaveLength(0);
    // Every aired (missing) episode excluded from scope.
    const excluded = calls.wantedUpdateMany.find(
      (c: any) => c.where?.status === 'missing' && c.data?.excludedFromScope === true,
    );
    expect(excluded).toBeTruthy();
  });

  it('does not enqueue a backfill when nothing is missing', async () => {
    const { svc, calls } = harness({ scan: { missing: 0 } });
    const res = await svc.provisionSeriesAcquisition(base);
    expect(res.backfillJobId).toBeNull();
    expect(calls.backfillEnqueue).toHaveLength(0);
  });

  it('ended show + monitor without confirmation: plan flags it and provision refuses', async () => {
    const { svc } = harness({ status: 'ended' });
    const plan = await svc.planSeriesAcquisition(base);
    expect(plan.requiresInactiveConfirmation).toBe(true);
    expect(plan.ready).toBe(false);
    await expect(svc.provisionSeriesAcquisition(base)).rejects.toThrow(/ended or been canceled/i);
  });

  it('ended show + confirmation: provisions and allows inactive monitoring on the rule', async () => {
    const { svc, calls } = harness({ status: 'ended', scan: { missing: 2 } });
    const res = await svc.provisionSeriesAcquisition({ ...base, allowInactiveShowMonitoring: true });
    expect(res.ruleEnabled).toBe(true);
    expect(calls.rssRuleUpdateMany[0].data).toMatchObject({
      isEnabled: true,
      allowInactiveShowMonitoring: true,
    });
    // The override is audited.
    expect(calls.audit[0].metadata).toMatchObject({ inactiveShowOverride: true });
  });

  it('ended show + backfill_only does NOT require confirmation (no monitoring)', async () => {
    const { svc } = harness({ status: 'canceled', scan: { missing: 2 } });
    const plan = await svc.planSeriesAcquisition({ ...base, mode: 'backfill_only' });
    expect(plan.requiresInactiveConfirmation).toBe(false);
    expect(plan.ready).toBe(true);
  });

  it('idempotent: an existing watchlist item is linked, not duplicated', async () => {
    const { svc } = harness({
      existing: { id: 'wl1', status: 'active', rssRuleId: 'rule1' },
      linkOutcome: 'unchanged',
      scan: { missing: 1 },
    });
    const res = await svc.provisionSeriesAcquisition(base);
    expect(res.alreadyExisted).toBe(true);
    expect(res.watchlistItemId).toBe('wl1');
  });

  it('season scope: episodes outside requested seasons are excluded, requested ones re-included', async () => {
    const { svc, calls } = harness({ scan: { missing: 6 } });
    await svc.provisionSeriesAcquisition({ ...base, seasons: [1, 2] });
    const out: any = calls.wantedUpdateMany.find(
      (c: any) => c.where?.seasonNumber?.notIn && c.data?.excludedFromScope === true,
    );
    const inc: any = calls.wantedUpdateMany.find(
      (c: any) => c.where?.seasonNumber?.in && c.data?.excludedFromScope === false,
    );
    expect(out?.where.seasonNumber.notIn).toEqual([1, 2]);
    expect(inc?.where.seasonNumber.in).toEqual([1, 2]);
  });

  it('a failed episode scan is a note, not a failure', async () => {
    const { svc } = harness({ scanThrows: true });
    const res = await svc.provisionSeriesAcquisition(base);
    expect(res.scan).toBeNull();
    expect(res.notes.some((n) => /scan skipped/i.test(n))).toBe(true);
    // Still provisioned the watchlist + rule.
    expect(res.watchlistItemId).toBe('wl1');
    expect(res.rssRuleId).toBe('rule1');
  });

  it('a hand-edited rule is left as the operator set it', async () => {
    const { svc } = harness({ ruleStillOurs: false, scan: { missing: 1 } });
    const res = await svc.provisionSeriesAcquisition({ ...base, mode: 'backfill_only' });
    // updateMany matched nothing; the rule keeps its own enabled state (mocked true).
    expect(res.ruleEnabled).toBe(true);
    expect(res.notes.some((n) => /hand-edited/i.test(n))).toBe(true);
  });

  it('plan() performs no writes', async () => {
    const { svc, calls, prisma } = harness();
    await svc.planSeriesAcquisition(base);
    expect(calls.linkOrCreate).toHaveLength(0);
    expect(calls.wantedUpdateMany).toHaveLength(0);
    expect(prisma.rssRule.updateMany).not.toHaveBeenCalled();
  });
});
