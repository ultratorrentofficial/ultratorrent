import { MEDIA_FINDING_CODES } from '@ultratorrent/shared';

import { MediaIntelligenceProjectionService } from './media-intelligence-projection.service';
import { RecommendationService } from './recommendations/recommendation.service';

/**
 * The projection store, tested against hand-rolled stubs.
 *
 * The rules worth pinning here are the ones that quietly rot: a finding must be
 * RESOLVED rather than deleted (so "this was broken for three weeks" survives),
 * re-evaluating unchanged facts must update one row rather than accumulate a
 * duplicate every sweep, and an entity that has vanished must take its
 * projection with it rather than leave a row describing something gone.
 */

type Row = Record<string, unknown>;

function stubPrisma(over: { findings?: Row[]; entities?: boolean } = {}) {
  const findings: Row[] = [...(over.findings ?? [])];
  const projections: Row[] = [];
  const calls = {
    upsert: [] as Row[],
    created: [] as Row[],
    updated: [] as Row[],
    resolved: [] as Row[],
    /** Finding-history rows. Transitions only — never re-observations. */
    history: [] as Row[],
    deleted: 0,
  };
  let nextId = 0;

  const prisma = {
    // rebuildAll() pages over the source domains. Empty by default so a test
    // that only exercises refreshEntity stays cheap; the digest tests override
    // `entities` to make the sweep actually visit something.
    mediaItem: {
      findMany: jest.fn(async () => (over.entities ? [{ id: 'item-1' }] : [])),
    },
    mediaShow: {
      findMany: jest.fn(async () => []),
    },
    mediaIntelligenceProjection: {
      upsert: jest.fn(async (args: Row) => {
        calls.upsert.push(args);
        projections.push(args);
        return {};
      }),
      deleteMany: jest.fn(async () => {
        calls.deleted += 1;
        return { count: 1 };
      }),
    },
    mediaIntelligenceFinding: {
      findMany: jest.fn(async () => findings),
      // Returns an id: reconciliation records an `opened` history row against it.
      create: jest.fn(async (args: { data: Row }) => {
        calls.created.push(args.data);
        return { id: `f${nextId++}`, ...args.data };
      }),
      update: jest.fn(async (args: Row) => {
        calls.updated.push(args);
        return {};
      }),
      updateMany: jest.fn(async (args: Row) => {
        calls.resolved.push(args);
        return { count: 1 };
      }),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
    // Phase 4 reconciles recommendations in the same sweep. Stubbed here
    // because the projection service now calls it; the recommendation rules
    // themselves are tested against their own pure spec.
    mediaIntelligenceRecommendation: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    mediaIntelligenceFindingEvent: {
      createMany: jest.fn(async (args: { data: Row[] }) => {
        calls.history.push(...args.data);
        return { count: args.data.length };
      }),
    },
    $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  };
  return { prisma, calls, projections };
}

/** Facts shaped just enough for the evaluator to reach a verdict. */
function assembled(over: { missing?: number | null; failedIntake?: number } = {}) {
  const known = (source: string) => ({ status: 'known' as const, source, observedAt: null });
  return {
    hygieneScore: 90,
    facts: {
      entityType: 'series',
      entityId: 'show-1',
      identity: {
        ...known('media_manager'), title: 'Breaking Bad', normalizedTitle: 'breaking bad', year: 2008,
        seasonNumber: null, episodeNumber: null, episodeTitle: null,
        externalIds: { imdb: 'tt0903747' }, matchStatus: 'matched', confidence: 1, conflictingExternalIds: false,
      },
      library: {
        ...known('media_manager'), present: true, libraryId: 'lib-1', libraryName: 'TV Shows',
        libraryKind: 'tv', path: null, fileCount: 62, episodeCount: 62, seasonCount: 5,
        totalBytes: 386_000_000_000, duplicateGroupCount: 0, duplicateReclaimableBytes: 0,
        lastScanAt: '2026-09-15T00:00:00.000Z',
      },
      completeness: {
        ...known('media_acquisition'), expected: 62, owned: 62 - (over.missing ?? 0),
        missing: over.missing ?? 0, unaired: 0, ignored: 0, excludedFromScope: null,
        completionPercent: 100, showStatus: 'ended',
      },
      technical: {
        ...known('media_manager'), measuredFileCount: 62, unprobedFileCount: 0, unmeasurableFileCount: 0,
        profile: null, distinctProfileCount: 1, declared: null,
      },
      metadata: { ...known('media_manager'), provider: 'tvdb', hasOverview: true, hasGenres: true, year: 2008, runtimeMinutes: null, nfoPresent: true, updatedAt: null },
      artwork: { ...known('media_manager'), posterPresent: true, fanartPresent: true, typesPresent: ['poster', 'fanart'], missingRequiredCount: 0 },
      subtitles: { ...known('media_manager'), languages: ['en'], itemsWithSubtitles: 62, itemsTotal: 62, embeddedTracksKnown: false },
      acquisition: { ...known('media_acquisition'), monitored: false, watchlistItemId: null, mode: null, watchlistStatus: null, ruleId: null, ruleEnabled: null, usesGlobalPreferences: null, searchesPending: null, searchesFailed: null, searchesNoResults: null, lastSearchAt: null, lastGrabAt: null, activeBackfillJobId: null },
      intake: { ...known('media_intake'), total: 62, active: 0, imported: 62, failed: over.failedIntake ?? 0, quarantined: 0, lastIntakeAt: null, lastError: null },
      torrent: { ...known('torrents'), associatedCount: 57, seedingCount: 51, erroredCount: 0, linkedItemCount: 57, consideredItemCount: 62 },
      usage: { ...known('media_server_analytics'), playCount: 23, completedPlayCount: 20, uniqueViewerCount: 4, lastPlayedAt: '2026-09-07T00:00:00.000Z', totalPlaybackSeconds: 1000, approximate: true },
      storage: { ...known('media_manager'), totalBytes: 386_000_000_000, fileCount: 62, duplicateBytes: 0, reclaimableBytes: 0, storageProfileId: null, storageProfileName: null },
    },
  };
}

function build(over: { findings?: Row[]; assembled?: unknown; entities?: boolean } = {}) {
  const { prisma, calls, projections } = stubPrisma({ findings: over.findings, entities: over.entities });
  const assembler = {
    assemble: jest.fn(async () => (over.assembled === undefined ? assembled() : over.assembled)),
  };
  const bus = { publish: jest.fn(() => ({ published: true, eventId: 'e1' })) };
  /*
   * A REAL RecommendationService over the same stub, not a mock. The
   * recommendation pass runs inside `refreshEntity`, so wiring the genuine
   * one means these tests also prove that pass cannot break finding
   * reconciliation — which is the whole risk of settling both in one sweep.
   */
  const recommendations = new RecommendationService(prisma as never);
  const svc = new MediaIntelligenceProjectionService(
    prisma as never,
    assembler as never,
    bus as never,
    recommendations,
  );
  return { svc, prisma, calls, projections, assembler, bus, recommendations };
}

describe('MediaIntelligenceProjectionService.refreshEntity', () => {
  it('writes a projection row for a healthy entity, not just for broken ones', async () => {
    const { svc, calls } = build();
    const result = await svc.refreshEntity('series', 'show-1');

    expect(result).toMatchObject({ health: 'healthy', findingCount: 0 });
    expect(calls.upsert).toHaveLength(1);
    const data = (calls.upsert[0] as { create: Record<string, unknown> }).create;
    expect(data.title).toBe('Breaking Bad');
    expect(data.healthStatus).toBe('healthy');
    // Provenance must be written, or a stale row later reads as current.
    expect(data.calculatedAt).toBeInstanceOf(Date);
  });

  it('opens a finding the first time it is observed', async () => {
    const { svc, calls } = build({ assembled: assembled({ missing: 3 }) });
    const result = await svc.refreshEntity('series', 'show-1');

    expect(result?.health).toBe('attention');
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]).toMatchObject({
      code: MEDIA_FINDING_CODES.EPISODES_MISSING,
      domain: 'completeness',
      severity: 'warning',
    });
  });

  it('updates the existing row on re-observation instead of duplicating it', async () => {
    const { svc, calls } = build({
      findings: [{ id: 'f1', code: MEDIA_FINDING_CODES.EPISODES_MISSING, resolvedAt: null, severity: 'warning', evidence: { missing: 3 }, disposition: 'unreviewed', snoozedUntil: null }],
      assembled: assembled({ missing: 3 }),
    });
    await svc.refreshEntity('series', 'show-1');

    expect(calls.created).toHaveLength(0);
    expect(calls.updated).toHaveLength(1);
    // firstObservedAt is deliberately absent from the update payload — "since
    // when" must survive every re-evaluation.
    const data = (calls.updated[0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('firstObservedAt');
    expect(data.lastObservedAt).toBeInstanceOf(Date);
  });

  it('RESOLVES a finding that stops reproducing, and never deletes it', async () => {
    const { svc, calls, prisma } = build({
      findings: [{ id: 'f1', code: MEDIA_FINDING_CODES.EPISODES_MISSING, resolvedAt: null, severity: 'warning', evidence: { missing: 3 }, disposition: 'unreviewed', snoozedUntil: null }],
      assembled: assembled({ missing: 0 }),
    });
    await svc.refreshEntity('series', 'show-1');

    expect(calls.resolved).toHaveLength(1);
    const args = calls.resolved[0] as { where: { id: { in: string[] } }; data: Record<string, unknown> };
    expect(args.where.id.in).toEqual(['f1']);
    expect(args.data.resolvedAt).toBeInstanceOf(Date);
    expect(prisma.mediaIntelligenceFinding.deleteMany).not.toHaveBeenCalled();
  });

  it('re-opens a previously resolved finding rather than leaving it closed', async () => {
    const { svc, calls } = build({
      findings: [{ id: 'f1', code: MEDIA_FINDING_CODES.EPISODES_MISSING, resolvedAt: new Date('2026-01-01'), severity: 'warning', evidence: { missing: 2 }, disposition: 'unreviewed', snoozedUntil: null }],
      assembled: assembled({ missing: 2 }),
    });
    await svc.refreshEntity('series', 'show-1');

    const data = (calls.updated[0] as { data: Record<string, unknown> }).data;
    expect(data.resolvedAt).toBeNull();
  });

  it('forgets the projection when the entity no longer exists', async () => {
    const { svc, calls } = build({ assembled: null });
    const result = await svc.refreshEntity('movie', 'gone');

    expect(result).toBeNull();
    expect(calls.deleted).toBeGreaterThan(0);
    expect(calls.upsert).toHaveLength(0);
  });

  it('counts findings by severity with every severity present', async () => {
    const { svc, calls } = build({ assembled: assembled({ missing: 1, failedIntake: 1 }) });
    await svc.refreshEntity('series', 'show-1');

    const data = (calls.upsert[0] as { create: Record<string, unknown> }).create;
    expect(data.findingCounts).toMatchObject({ info: 0, opportunity: 0, warning: 1, error: 1, critical: 0 });
    // An error outranks a warning: severity-aware, never averaged.
    expect(data.healthStatus).toBe('degraded');
  });

  it('bounds the stored row summary', async () => {
    const { svc, calls } = build({ assembled: assembled({ missing: 4, failedIntake: 2 }) });
    await svc.refreshEntity('series', 'show-1');

    const data = (calls.upsert[0] as { create: Record<string, unknown> }).create;
    const summary = data.summary as { topFindings: unknown[]; totalFindings: number };
    expect(summary.topFindings.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(summary).length).toBeLessThan(2000);
  });

  it('records which domains were unknown so the row cannot read as fully known', async () => {
    const base = assembled();
    const withUnknown = {
      ...base,
      facts: {
        ...base.facts,
        usage: { status: 'unknown', source: 'media_server_analytics', observedAt: null, unknownReason: 'no_aggregate', playCount: null, completedPlayCount: null, uniqueViewerCount: null, lastPlayedAt: null, totalPlaybackSeconds: null, approximate: true },
      },
    };
    const { svc, calls } = build({ assembled: withUnknown });
    await svc.refreshEntity('series', 'show-1');

    const data = (calls.upsert[0] as { create: Record<string, unknown> }).create;
    expect(data.unknownDomains).toContain('usage');
  });
});

describe('MediaIntelligenceProjectionService.rebuildAll', () => {
  it('refuses to run twice concurrently', async () => {
    const { svc } = build();
    (svc as unknown as { rebuilding: boolean }).rebuilding = true;
    const result = await svc.rebuildAll();
    expect(result.skipped).toBe(true);
    expect(svc.isRebuilding()).toBe(true);
  });
});

describe('MediaIntelligenceProjectionService — human disposition survives reconciliation', () => {
  const dismissed = (over: Row = {}) => ({
    id: 'f1',
    code: MEDIA_FINDING_CODES.EPISODES_MISSING,
    resolvedAt: null,
    severity: 'warning',
    // Exactly what evaluateCompleteness emits — a partial fixture makes the
    // fingerprint differ and the disposition reset for the wrong reason.
    evidence: { missing: 3, expected: 62, owned: 59, unaired: 0, ignored: 0 },
    disposition: 'dismissed',
    snoozedUntil: null,
    ...over,
  });

  it('PRESERVES a dismissal when the same condition is merely re-observed', async () => {
    // The sweep runs every six hours over the whole library. If a routine
    // re-observation cleared dispositions, nothing could ever stay dismissed.
    const { svc, calls } = build({
      findings: [dismissed()],
      assembled: assembled({ missing: 3 }),
    });
    await svc.refreshEntity('series', 'show-1');

    const data = (calls.updated[0] as { data: Record<string, unknown> }).data;
    expect(data).not.toHaveProperty('disposition');
    expect(calls.history).toHaveLength(0);
  });

  it('CLEARS a dismissal when the affected count grows materially', async () => {
    const { svc, calls } = build({
      findings: [dismissed({ evidence: { missing: 1, expected: 62, owned: 61, unaired: 0, ignored: 0 } })],
      assembled: assembled({ missing: 12 }),
    });
    await svc.refreshEntity('series', 'show-1');

    const data = (calls.updated[0] as { data: Record<string, unknown> }).data;
    expect(data.disposition).toBe('unreviewed');
    expect(data.snoozedUntil).toBeNull();
    expect(data.escalationReason).toBe('affected_count_increased');
    expect(calls.history.map((h) => h.event)).toContain('disposition_reset_by_escalation');
  });

  it('never lets a disposition rewrite the technical verdict', async () => {
    const { svc, calls } = build({
      findings: [dismissed()],
      assembled: assembled({ missing: 3 }),
    });
    await svc.refreshEntity('series', 'show-1');
    // resolvedAt is the evaluator's business; dismissal must not touch it.
    const data = (calls.updated[0] as { data: Record<string, unknown> }).data;
    expect(data.resolvedAt).toBeNull();
  });

  it('records history for transitions, never for observations', async () => {
    const { svc, calls } = build({ assembled: assembled({ missing: 3 }) });
    await svc.refreshEntity('series', 'show-1');
    // One newly-opened finding, so exactly one history row.
    expect(calls.history).toHaveLength(1);
    expect(calls.history[0]).toMatchObject({ event: 'opened' });
  });

  it('records a severity change and reports it as a transition', async () => {
    const { svc, calls } = build({
      findings: [dismissed({ severity: 'info' })],
      assembled: assembled({ missing: 3 }),
    });
    const result = await svc.refreshEntity('series', 'show-1');
    expect(calls.history.map((h) => h.event)).toContain('severity_changed');
    expect(result?.transitions.some((t) => t.kind === 'escalated')).toBe(true);
  });

  it('reports no transitions when an existing finding is unchanged', async () => {
    // The bootstrap guarantee: the first sweep after Phase 3 ships finds every
    // finding already present, so nothing reads as newly opened and no digest
    // is published for a library that did not change.
    const { svc } = build({
      findings: [dismissed({ disposition: 'unreviewed' })],
      assembled: assembled({ missing: 3 }),
    });
    const result = await svc.refreshEntity('series', 'show-1');
    expect(result?.transitions).toHaveLength(0);
  });
});

describe('MediaIntelligenceProjectionService — digest flood control', () => {
  it('publishes NOTHING when a sweep changes nothing', async () => {
    // The bootstrap guarantee, and the steady state: a six-hourly sweep over
    // an unchanged library must not notify anyone.
    const { svc, bus } = build({
      findings: [
        {
          id: 'f1', code: MEDIA_FINDING_CODES.EPISODES_MISSING, resolvedAt: null, severity: 'warning',
          evidence: { missing: 3, expected: 62, owned: 59, unaired: 0, ignored: 0 },
          disposition: 'unreviewed', snoozedUntil: null,
        },
      ],
      assembled: assembled({ missing: 3 }),
      entities: true,
    });
    await svc.rebuildAll();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('publishes ONE digest for a run, never one per finding', async () => {
    const { svc, bus } = build({ assembled: assembled({ missing: 3, failedIntake: 1 }), entities: true });
    await svc.rebuildAll();
    // Whatever the run touched, the operator gets a single summary.
    expect(bus.publish.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
