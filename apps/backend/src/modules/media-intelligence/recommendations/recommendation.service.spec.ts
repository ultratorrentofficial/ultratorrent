import { MEDIA_FINDING_CODES } from '@ultratorrent/shared';

import { RecommendationService } from './recommendation.service';

/**
 * Persisting and reconciling recommendations.
 *
 * The properties worth pinning are the ones a later refactor would quietly
 * break: a rebuild must UPDATE rather than accumulate, a resolved finding must
 * leave its recommendation `satisfied` rather than deleted, an evidence change
 * must not let a stale candidate keep claiming availability, and none of it
 * may write Phase 3 disposition state.
 */

type Row = Record<string, unknown>;

function stub(existing: Row[] = []) {
  const calls = {
    upserts: [] as Row[],
    updateManys: [] as Row[],
  };
  const prisma = {
    mediaIntelligenceRecommendation: {
      findMany: jest.fn(async () => existing),
      upsert: jest.fn(async (args: Row) => {
        calls.upserts.push(args);
        return {};
      }),
      updateMany: jest.fn(async (args: Row) => {
        calls.updateManys.push(args);
        return { count: 1 };
      }),
    },
  };
  return { svc: new RecommendationService(prisma as never), prisma, calls };
}

const NOW = new Date('2026-09-16T12:00:00.000Z');

const finding = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'f1',
  code: MEDIA_FINDING_CODES.DUPLICATE_MEDIA_PRESENT as string,
  severity: 'warning',
  evidence: { groups: 2, reclaimableBytes: 1024 } as Record<string, unknown>,
  resolved: false,
  ...over,
});

describe('RecommendationService.reconcile', () => {
  it('addresses a recommendation by its LOGICAL identity, not a new row', async () => {
    const { svc, calls } = stub();
    await svc.reconcile('series', 'show-1', [finding()], NOW);

    expect(calls.upserts).toHaveLength(1);
    // (findingId, type) is the durable key — this is what makes a rebuild
    // idempotent instead of a source of duplicates.
    expect(calls.upserts[0].where).toEqual({
      findingId_type: { findingId: 'f1', type: 'REVIEW_DUPLICATES' },
    });
  });

  it('is idempotent: re-running over unchanged findings writes no second row', async () => {
    const { svc, calls } = stub([
      {
        id: 'r1', findingId: 'f1', type: 'REVIEW_DUPLICATES', status: 'active',
        confidence: 'high', evidence: { groups: 2, reclaimableBytes: 1024 },
        verification: 'not_required', verifiedAt: null,
      },
    ]);
    await svc.reconcile('series', 'show-1', [finding()], NOW);

    // One upsert against the same key, and nothing marked stale.
    expect(calls.upserts).toHaveLength(1);
    expect(calls.updateManys).toHaveLength(0);
  });

  it('marks a recommendation SATISFIED when its finding resolved', async () => {
    const { svc, calls } = stub([
      { id: 'r1', findingId: 'f1', type: 'REVIEW_DUPLICATES', status: 'active',
        confidence: 'high', evidence: {}, verification: 'not_required', verifiedAt: null },
    ]);
    await svc.reconcile('series', 'show-1', [finding({ resolved: true })], NOW);

    expect(calls.upserts).toHaveLength(0);
    const data = calls.updateManys[0].data as Row;
    // Satisfied, never deleted: "this was recommended and then the problem
    // went away" is exactly the history that proves the system helped.
    expect(data.status).toBe('satisfied');
    expect(data.invalidationReason).toBe('finding_resolved');
  });

  it('distinguishes "the condition went away" from "this stopped applying"', async () => {
    const { svc, calls } = stub([
      { id: 'r1', findingId: 'f-gone', type: 'REVIEW_DUPLICATES', status: 'active',
        confidence: 'high', evidence: {}, verification: 'not_required', verifiedAt: null },
    ]);
    // The finding is still OPEN but no longer produces this recommendation.
    await svc.reconcile('series', 'show-1', [], NOW);

    const data = calls.updateManys[0].data as Row;
    expect(data.status).toBe('invalidated');
    expect(data.invalidationReason).toBe('evidence_changed');
  });

  it('drops a verification when the evidence underneath it moved', async () => {
    const { svc, calls } = stub([
      {
        id: 'r1', findingId: 'f1', type: 'SEARCH_FOR_QUALITY_UPGRADE', status: 'active',
        confidence: 'medium',
        // The owned copy was different when this was verified.
        evidence: { ownedResolution: '720p', matchedRung: 3 },
        verification: 'verified',
        verifiedAt: new Date('2026-09-16T11:00:00.000Z'),
      },
    ]);
    await svc.reconcile(
      'series',
      'show-1',
      [
        finding({
          code: MEDIA_FINDING_CODES.QUALITY_UPGRADE_POTENTIAL,
          evidence: { ownedResolution: '1080p', matchedRung: 1, totalRungs: 4 },
        }),
      ],
      NOW,
    );

    const update = calls.upserts[0].update as Row;
    // A candidate compared against the OLD copy proves nothing about the new
    // one, so the claim of availability is withdrawn rather than inherited.
    expect(update.verification).toBe('not_checked');
    expect(update.verifiedAt).toBeNull();
  });

  it('keeps a verification when the evidence did not move', async () => {
    const evidence = {
      ownedResolution: '1080p', matchedRung: 1, matchedRungName: null,
      preferredRung: null, totalRungs: 4, preferenceSource: null,
    };
    const { svc, calls } = stub([
      { id: 'r1', findingId: 'f1', type: 'SEARCH_FOR_QUALITY_UPGRADE', status: 'active',
        confidence: 'medium', evidence, verification: 'verified',
        verifiedAt: new Date('2026-09-16T11:00:00.000Z') },
    ]);
    await svc.reconcile(
      'series', 'show-1',
      [finding({ code: MEDIA_FINDING_CODES.QUALITY_UPGRADE_POTENTIAL, evidence })],
      NOW,
    );

    const update = calls.upserts[0].update as Row;
    expect(update.verification).toBeUndefined();
  });

  it('never writes Phase 3 disposition state', async () => {
    const { svc, prisma, calls } = stub();
    await svc.reconcile('series', 'show-1', [finding()], NOW);

    const written = JSON.stringify(calls.upserts);
    for (const forbidden of ['disposition', 'snoozedUntil', 'dispositionAt', 'escalationReason']) {
      expect(written).not.toContain(forbidden);
    }
    // And it touches no finding table at all.
    expect(Object.keys(prisma)).toEqual(['mediaIntelligenceRecommendation']);
  });

  it('produces nothing for a finding with no supported remedy', async () => {
    const { svc, calls } = stub();
    await svc.reconcile(
      'movie', 'm-1',
      [finding({ code: MEDIA_FINDING_CODES.MEDIA_TECHNICAL_DATA_MISSING })],
      NOW,
    );
    expect(calls.upserts).toHaveLength(0);
  });
});

describe('RecommendationService.expireStaleVerifications', () => {
  it('ages a verified candidate out without calling any provider', async () => {
    const { svc, prisma } = stub();
    await svc.expireStaleVerifications(NOW);

    const args = (prisma.mediaIntelligenceRecommendation.updateMany as jest.Mock).mock.calls[0][0];
    expect(args.where.verification).toBe('verified');
    // Bounded by an indexed cutoff, not a row-by-row sweep.
    expect(args.where.verifiedAt.lt).toBeInstanceOf(Date);
    expect(args.data).toEqual({ verification: 'stale' });
  });

  it('expires on the clock it was given, never on wall time', async () => {
    const { svc, prisma } = stub();
    await svc.expireStaleVerifications(NOW);
    const args = (prisma.mediaIntelligenceRecommendation.updateMany as jest.Mock).mock.calls[0][0];
    // 12 hours before the injected `now`.
    expect((args.where.verifiedAt.lt as Date).toISOString()).toBe('2026-09-16T00:00:00.000Z');
  });
});
