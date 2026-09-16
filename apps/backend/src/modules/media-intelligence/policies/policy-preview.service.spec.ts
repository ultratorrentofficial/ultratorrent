import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LIFECYCLE_PREVIEW_LIMIT } from '@ultratorrent/shared';

import { PolicyPreviewService } from './policy-preview.service';

/**
 * "What would this policy do?" — asked before the policy exists.
 *
 * The claims worth pinning are the ones that make a preview trustworthy: that
 * it mutates nothing, that the draft competes in precedence exactly as a saved
 * policy would (including LOSING), that a bounded sample is never presented as
 * a whole-library verdict, and that one entity counts once by its worst
 * outcome rather than being averaged into looking fine.
 */

type Row = Record<string, unknown>;

/** A drift verdict, as `evaluateWith` returns it. */
const drift = (dimension: string, status: string) => ({
  dimension,
  status,
  desired: null,
  actual: null,
  unknownReason: null,
  source: null,
  evidence: {},
});

function stub(options: {
  saved?: Row[];
  projection?: Row[];
  total?: number;
  libraries?: Row[];
  /** Verdicts per entity id, in call order. */
  verdicts?: Record<string, Array<{ dimension: string; status: string }>>;
} = {}) {
  const projection = options.projection ?? [];
  const seen: Array<{ policies: Row[]; entityId: string }> = [];
  const writes: string[] = [];

  const prisma = {
    mediaIntelligenceProjection: {
      findMany: jest.fn(async (args: { take?: number }) => {
        writes.push('findMany');
        return projection.slice(0, args?.take ?? projection.length);
      }),
      count: jest.fn(async () => options.total ?? projection.length),
    },
    mediaLibrary: {
      findMany: jest.fn(async () => options.libraries ?? []),
    },
  };

  const policies = { enabled: jest.fn(async () => options.saved ?? []) };

  const evaluation = {
    evaluateWith: jest.fn(async (pols: Row[], _t: string, entityId: string) => {
      seen.push({ policies: pols, entityId });
      const verdicts = options.verdicts?.[entityId];
      if (verdicts === undefined) return null;
      return {
        entityType: 'movie',
        entityId,
        desiredState: {},
        drifts: verdicts.map((v) => drift(v.dimension, v.status)),
        evaluatedAt: '2026-09-16T00:00:00.000Z',
      };
    }),
  };

  return {
    svc: new PolicyPreviewService(prisma as never, policies as never, evaluation as never),
    prisma,
    policies,
    evaluation,
    seen,
  };
}

const entity = (id: string, over: Row = {}) => ({
  entityType: 'movie',
  entityId: id,
  title: `Title ${id}`,
  ...over,
});

describe('PolicyPreviewService — the draft participates, it does not preempt', () => {
  it('evaluates the draft alongside the saved policies', async () => {
    const saved = [{ id: 'p1', name: 'Global', scopeType: 'global' }];
    const { svc, seen } = stub({
      saved,
      projection: [entity('m1')],
      verdicts: { m1: [{ dimension: 'quality', status: 'compliant' }] },
    });

    await svc.preview({ name: 'Draft', scopeType: 'library', scopeId: 'lib-1', quality: 'maintain_preferred' });

    // The question is "what happens if I save this", not "what does this say
    // in isolation" — so the saved policies must still be in the list.
    expect(seen[0].policies.map((p) => (p as { id: string }).id)).toEqual(['p1', '__draft__']);
  });

  it('previews the EDIT of a saved policy, never both versions of it', async () => {
    const saved = [
      { id: 'p1', name: 'Old name', scopeType: 'global', quality: 'maintain_acceptable' },
      { id: 'p2', name: 'Other', scopeType: 'global' },
    ];
    const { svc, seen } = stub({
      saved,
      projection: [entity('m1')],
      verdicts: { m1: [{ dimension: 'quality', status: 'compliant' }] },
    });

    await svc.preview({ id: 'p1', name: 'New name', quality: 'maintain_preferred' });

    const ids = seen[0].policies.map((p) => (p as { id: string }).id);
    // p1 appears exactly once, as the draft — not twice, once stale.
    expect(ids).toEqual(['p2', 'p1']);
    const edited = seen[0].policies.find((p) => (p as { id: string }).id === 'p1') as Row;
    expect(edited.name).toBe('New name');
    expect(edited.quality).toBe('maintain_preferred');
  });

  it('evaluates a disabled policy as if it were on', async () => {
    const { svc, seen } = stub({
      projection: [entity('m1')],
      verdicts: { m1: [{ dimension: 'quality', status: 'compliant' }] },
    });

    await svc.preview({ id: 'p1', name: 'Currently off', quality: 'maintain_preferred' });

    // "What would this do" is the question; a disabled policy answers
    // "nothing", which is useless to someone deciding whether to enable it.
    expect((seen[0].policies[0] as Row).enabled).toBe(true);
  });

  it('gives an unsaved draft a visibly synthetic id', async () => {
    const { svc, seen } = stub({
      projection: [entity('m1')],
      verdicts: { m1: [{ dimension: 'quality', status: 'compliant' }] },
    });

    await svc.preview({ name: 'Draft' });

    // Deterministic, so precedence ties resolve the same way every run, and
    // impossible to mistake for a persisted policy in provenance output.
    expect(seen[0].policies[0]).toMatchObject({ id: PolicyPreviewService.DRAFT_ID });
    expect(PolicyPreviewService.DRAFT_ID).toBe('__draft__');
  });
});

describe('PolicyPreviewService — it mutates nothing', () => {
  it('writes no policy, projection, recommendation or media row', async () => {
    const { svc, prisma } = stub({
      projection: [entity('m1')],
      verdicts: { m1: [{ dimension: 'quality', status: 'drift' }] },
    });

    await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });

    // Only the two reads the preview is allowed to make.
    expect(Object.keys(prisma)).toEqual(['mediaIntelligenceProjection', 'mediaLibrary']);
    expect(Object.keys(prisma.mediaIntelligenceProjection)).toEqual(['findMany', 'count']);
  });

  it('contains no database write anywhere in its source', () => {
    /*
     * Structural, because the behavioural test above can only prove the paths
     * it exercises. A draft that is persisted-then-rolled-back would still be
     * a write, and rollback is exactly the shortcut someone reaches for when
     * the in-memory injection gets inconvenient.
     */
    const source = readFileSync(join(__dirname, 'policy-preview.service.ts'), 'utf8');
    const write = /prisma\.\w+\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b|\$executeRaw|\$transaction/;
    expect(write.test(source)).toBe(false);
  });
});

describe('PolicyPreviewService — bounded, and honest about it', () => {
  it('caps the query itself rather than over-fetching and discarding', async () => {
    const { svc, prisma } = stub({ projection: [], total: 0 });
    await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });

    const args = prisma.mediaIntelligenceProjection.findMany.mock.calls[0][0] as { take: number };
    expect(args.take).toBe(LIFECYCLE_PREVIEW_LIMIT);
  });

  it('reports truncation when the scope holds more than the cap', async () => {
    const { svc } = stub({
      projection: [entity('m1')],
      total: 3354,
      verdicts: { m1: [{ dimension: 'quality', status: 'compliant' }] },
    });

    const out = await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });

    // Claiming a whole-library verdict from a sample is the confident
    // wrongness this module exists to avoid.
    expect(out.truncated).toBe(true);
    expect(out.evaluated).toBe(1);
  });

  it('does not claim truncation when the scope fits', async () => {
    const { svc } = stub({
      projection: [entity('m1')],
      total: 1,
      verdicts: { m1: [{ dimension: 'quality', status: 'compliant' }] },
    });
    expect((await svc.preview({ name: 'Draft', quality: 'maintain_preferred' })).truncated).toBe(false);
  });

  it('orders deterministically, so two previews of one scope compare like with like', async () => {
    const { svc, prisma } = stub({ projection: [], total: 0 });
    await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });

    const args = prisma.mediaIntelligenceProjection.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(args.orderBy).toEqual([{ entityType: 'asc' }, { entityId: 'asc' }]);
  });
});

describe('PolicyPreviewService — counting', () => {
  it('counts an entity once, by its WORST outcome', async () => {
    const { svc } = stub({
      projection: [entity('m1')],
      verdicts: {
        m1: [
          { dimension: 'quality', status: 'compliant' },
          { dimension: 'completeness', status: 'drift' },
          { dimension: 'subtitleLanguages', status: 'unknown' },
        ],
      },
    });

    const out = await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });

    // Averaging the dimensions would hide the title that needs attention.
    expect(out.evaluated).toBe(1);
    expect(out.drift).toBe(1);
    expect(out.compliant).toBe(0);
    expect(out.unknown).toBe(0);
  });

  it('ranks unknown above compliant, so a title nobody could measure is not called fine', async () => {
    const { svc } = stub({
      projection: [entity('m1')],
      verdicts: {
        m1: [
          { dimension: 'quality', status: 'compliant' },
          { dimension: 'subtitleLanguages', status: 'unknown' },
        ],
      },
    });

    const out = await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });
    expect(out.unknown).toBe(1);
    expect(out.compliant).toBe(0);
  });

  it('breaks the count down per dimension as well as per entity', async () => {
    const { svc } = stub({
      projection: [entity('m1'), entity('m2')],
      verdicts: {
        m1: [{ dimension: 'quality', status: 'drift' }],
        m2: [{ dimension: 'quality', status: 'compliant' }],
      },
    });

    const out = await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });
    expect(out.byDimension.quality).toEqual({ compliant: 1, drift: 1, unknown: 0, notApplicable: 0 });
  });

  it('samples drifting entities for drill-down, and only drifting ones', async () => {
    const { svc } = stub({
      projection: [entity('m1'), entity('m2')],
      verdicts: {
        m1: [{ dimension: 'quality', status: 'drift' }],
        m2: [{ dimension: 'quality', status: 'compliant' }],
      },
    });

    const out = await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });
    expect(out.samples).toEqual([
      { entityType: 'movie', entityId: 'm1', title: 'Title m1', dimensions: ['quality'] },
    ]);
  });

  it('skips an entity that vanished mid-preview rather than failing the run', async () => {
    const { svc } = stub({
      projection: [entity('m1'), entity('gone')],
      // `gone` has no verdicts, so `evaluateWith` returns null.
      verdicts: { m1: [{ dimension: 'quality', status: 'compliant' }] },
    });

    const out = await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });
    expect(out.evaluated).toBe(1);
  });
});

describe('PolicyPreviewService — scope resolution', () => {
  it('filters by library id for a library scope', async () => {
    const { svc, prisma } = stub({ projection: [], total: 0 });
    await svc.preview({ name: 'Draft', scopeType: 'library', scopeId: 'lib-1', quality: 'maintain_preferred' });

    const args = prisma.mediaIntelligenceProjection.findMany.mock.calls[0][0] as { where: Row };
    expect(args.where).toEqual({ libraryId: 'lib-1' });
  });

  it('resolves a media kind to its libraries INSIDE the query, keeping the cap meaningful', async () => {
    const { svc, prisma } = stub({
      projection: [],
      total: 0,
      libraries: [{ id: 'lib-1' }, { id: 'lib-2' }],
    });

    await svc.preview({ name: 'Draft', scopeType: 'media_kind', scopeId: 'tv', quality: 'maintain_preferred' });

    // Filtering AFTER the take would silently evaluate fewer entities than
    // the cap promises.
    const args = prisma.mediaIntelligenceProjection.findMany.mock.calls[0][0] as { where: Row };
    expect(args.where).toEqual({ libraryId: { in: ['lib-1', 'lib-2'] } });
  });

  it('evaluates nothing when a media kind matches no library', async () => {
    const { svc, prisma } = stub({ libraries: [] });
    const out = await svc.preview({ name: 'Draft', scopeType: 'media_kind', scopeId: 'nope', quality: 'maintain_preferred' });

    expect(out.evaluated).toBe(0);
    expect(out.truncated).toBe(false);
    expect(prisma.mediaIntelligenceProjection.findMany).not.toHaveBeenCalled();
  });

  it('scans everything for a global scope', async () => {
    const { svc, prisma } = stub({ projection: [], total: 0 });
    await svc.preview({ name: 'Draft', quality: 'maintain_preferred' });

    const args = prisma.mediaIntelligenceProjection.findMany.mock.calls[0][0] as { where: Row };
    expect(args.where).toEqual({});
  });

  it('ignores a scope id on a global draft rather than filtering by it', async () => {
    const { svc } = stub({ projection: [], total: 0 });
    const out = await svc.preview({ name: 'Draft', scopeType: 'global', scopeId: 'lib-1', quality: 'maintain_preferred' });
    expect(out.scopeId).toBeNull();
  });
});
