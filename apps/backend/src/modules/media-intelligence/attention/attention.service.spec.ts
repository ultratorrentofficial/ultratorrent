import { AttentionService } from './attention.service';

/**
 * The read side.
 *
 * Two properties matter more than the rest: the counters and the list must be
 * derived from the SAME predicate (a dashboard disagreeing with the list
 * beneath it destroys trust in both), and the list must not issue a query per
 * row for the media title.
 */

type Row = Record<string, unknown>;

const finding = (over: Row = {}): Row => ({
  id: 'f1',
  code: 'EPISODES_MISSING',
  domain: 'completeness',
  severity: 'warning',
  entityType: 'series',
  entityId: 'show-1',
  evidence: { missing: 3 },
  resolvedAt: null,
  firstObservedAt: new Date('2026-09-01T00:00:00.000Z'),
  lastObservedAt: new Date('2026-09-15T00:00:00.000Z'),
  disposition: 'unreviewed',
  snoozedUntil: null,
  dispositionAt: null,
  escalationReason: null,
  attentionPriority: 20,
  ...over,
});

function build(rows: Row[] = [finding()], projections: Row[] = []) {
  const calls = { findingWhere: [] as unknown[], projectionQueries: 0 };
  const prisma = {
    mediaIntelligenceFinding: {
      findMany: jest.fn(async (args: { where: unknown }) => {
        calls.findingWhere.push(args.where);
        return rows;
      }),
      count: jest.fn(async (args: { where: unknown }) => {
        calls.findingWhere.push(args.where);
        return rows.length;
      }),
      groupBy: jest.fn(async () => [{ severity: 'warning', _count: { _all: rows.length } }]),
    },
    mediaIntelligenceProjection: {
      findMany: jest.fn(async () => {
        calls.projectionQueries += 1;
        return projections;
      }),
    },
    mediaIntelligenceFindingEvent: { findMany: jest.fn(async () => []) },
  };
  return { svc: new AttentionService(prisma as never), prisma, calls };
}

const NOW = new Date('2026-09-15T12:00:00.000Z');

describe('AttentionService.list', () => {
  it('defaults to the active queue: open, not dismissed, snooze elapsed', async () => {
    const { svc, calls } = build();
    await svc.list({}, NOW);

    const where = calls.findingWhere[0] as Record<string, unknown>;
    expect(where.resolvedAt).toBeNull();
    // Either undecided/seen, or a snooze whose time has passed.
    expect(JSON.stringify(where.OR)).toContain('acknowledged');
    expect(JSON.stringify(where.OR)).toContain('snoozed');
  });

  it('shows snoozed findings only while the timer is unexpired', async () => {
    const { svc, calls } = build();
    await svc.list({ view: 'snoozed' }, NOW);
    const where = calls.findingWhere[0] as Record<string, unknown>;
    expect(where.disposition).toBe('snoozed');
    expect(where.snoozedUntil).toEqual({ gt: NOW });
  });

  it('keeps dismissed findings discoverable under their own view', async () => {
    const { svc, calls } = build();
    await svc.list({ view: 'dismissed' }, NOW);
    const where = calls.findingWhere[0] as Record<string, unknown>;
    // Still OPEN — dismissal never resolved anything.
    expect(where.resolvedAt).toBeNull();
    expect(where.disposition).toBe('dismissed');
  });

  it('issues ONE projection query for a whole page, not one per row', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => finding({ id: `f${i}`, entityId: `show-${i}` }));
    const { svc, calls } = build(rows);
    await svc.list({}, NOW);
    expect(calls.projectionQueries).toBe(1);
  });

  it('says so when a finding outlives its projection rather than rendering blank', async () => {
    const { svc } = build([finding()], []);
    const res = await svc.list({}, NOW);
    expect(res.items[0].title).toBe('(unknown title)');
  });

  it('decorates from the projection when one exists', async () => {
    const { svc } = build(
      [finding()],
      [{ entityType: 'series', entityId: 'show-1', title: 'Breaking Bad', year: 2008, libraryName: 'TV' }],
    );
    const res = await svc.list({}, NOW);
    expect(res.items[0]).toMatchObject({ title: 'Breaking Bad', year: 2008, libraryName: 'TV' });
  });

  it('never claims a dismissed finding is closed', async () => {
    const { svc } = build([finding({ disposition: 'dismissed' })]);
    const res = await svc.list({ view: 'dismissed' }, NOW);
    expect(res.items[0].open).toBe(true);
    expect(res.items[0].resolvedAt).toBeNull();
  });

  it('applies severity and domain filters server-side', async () => {
    const { svc, calls } = build();
    await svc.list({ severity: 'critical', domain: 'intake' }, NOW);
    const where = calls.findingWhere[0] as Record<string, unknown>;
    expect(where.severity).toBe('critical');
    expect(where.domain).toBe('intake');
  });

  it('narrows to escalated findings when asked', async () => {
    const { svc, calls } = build();
    await svc.list({ escalated: 'true' }, NOW);
    const where = calls.findingWhere[0] as Record<string, unknown>;
    expect(where.escalationReason).toEqual({ not: null });
  });

  it('returns an empty page when a title search matches nothing', async () => {
    const { svc, prisma } = build([finding()], []);
    const res = await svc.list({ q: 'nothing here' }, NOW);
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
    // And it does not then go on to query findings pointlessly.
    expect(prisma.mediaIntelligenceFinding.findMany).not.toHaveBeenCalled();
  });
});

describe('AttentionService.summary', () => {
  it('counts the active queue with the SAME predicate the list uses', async () => {
    const { svc, calls } = build();
    await svc.list({}, NOW);
    const listWhere = JSON.stringify(calls.findingWhere[0]);

    const { svc: svc2, prisma } = build();
    await svc2.summary(NOW);
    const groupWhere = JSON.stringify((prisma.mediaIntelligenceFinding.groupBy as jest.Mock).mock.calls[0][0].where);

    expect(groupWhere).toBe(listWhere);
  });

  it('reports every severity bucket even when empty', async () => {
    const { svc } = build();
    const s = await svc.summary(NOW);
    expect(s).toMatchObject({ critical: 0, error: 0, warning: 1, opportunity: 0, info: 0 });
    expect(s.active).toBe(1);
  });
});
