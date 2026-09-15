import { AttentionDispositionService } from './attention-disposition.service';

/**
 * The write side.
 *
 * The rule under test throughout: a disposition records what a person
 * decided and never rewrites what is true. The concurrency case matters most
 * — if a finding resolved a moment before the request arrived, dismissing it
 * must not drag it back open.
 */

type Row = Record<string, unknown>;

function build(rows: Row[] = []) {
  const calls = { updates: [] as Row[], history: [] as Row[] };
  const prisma = {
    mediaIntelligenceFinding: {
      findMany: jest.fn(async () => rows),
      updateMany: jest.fn(async (args: { where: { id: { in: string[] } }; data: Row }) => {
        calls.updates.push(args);
        return { count: args.where.id.in.length };
      }),
    },
    mediaIntelligenceFindingEvent: {
      createMany: jest.fn(async (args: { data: Row[] }) => {
        calls.history.push(...args.data);
        return { count: args.data.length };
      }),
    },
  };
  const svc = new AttentionDispositionService(prisma as never);
  return { svc, prisma, calls };
}

const open = (id: string, over: Row = {}): Row => ({
  id,
  severity: 'warning',
  disposition: 'unreviewed',
  resolvedAt: null,
  ...over,
});

const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

describe('AttentionDispositionService.apply', () => {
  it('acknowledges without demanding a reason', async () => {
    const { svc, calls } = build([open('f1')]);
    const r = await svc.apply('acknowledge', ['f1'], 'u1');

    expect(r.applied).toBe(1);
    expect((calls.updates[0].data as Row).disposition).toBe('acknowledged');
    expect((calls.updates[0].data as Row).dispositionBy).toBe('u1');
  });

  it('NEVER writes resolvedAt — only the evaluator may decide truth', async () => {
    const { svc, calls } = build([open('f1')]);
    await svc.apply('dismiss', ['f1'], 'u1');
    expect(calls.updates[0].data).not.toHaveProperty('resolvedAt');
    expect(calls.updates[0].data).not.toHaveProperty('severity');
    expect(calls.updates[0].data).not.toHaveProperty('evidence');
  });

  it('collapses duplicate ids into one decision', async () => {
    const { svc, prisma } = build([open('f1')]);
    await svc.apply('acknowledge', ['f1', 'f1', 'f1'], 'u1');
    const where = (prisma.mediaIntelligenceFinding.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.id.in).toEqual(['f1']);
  });

  it('reports unknown ids rather than failing the whole request', async () => {
    const { svc } = build([open('f1')]);
    const r = await svc.apply('acknowledge', ['f1', 'ghost'], 'u1');
    expect(r.applied).toBe(1);
    expect(r.unknown).toEqual(['ghost']);
  });

  it('SKIPS a finding that resolved between selection and request', async () => {
    // The concurrency guard. Resurrecting it would make a fixed problem
    // reappear because someone clicked dismiss a second too late.
    const { svc, calls } = build([open('f1'), open('f2', { resolvedAt: new Date() })]);
    const r = await svc.apply('dismiss', ['f1', 'f2'], 'u1');

    expect(r.skippedResolved).toEqual(['f2']);
    expect((calls.updates[0].where as { id: { in: string[] } }).id.in).toEqual(['f1']);
    // And the UPDATE itself re-checks, closing the millisecond-wide window.
    expect((calls.updates[0].where as Row).resolvedAt).toBeNull();
  });

  it('does nothing when every selected finding has resolved', async () => {
    const { svc, prisma } = build([open('f1', { resolvedAt: new Date() })]);
    const r = await svc.apply('dismiss', ['f1'], 'u1');
    expect(r.applied).toBe(0);
    expect(prisma.mediaIntelligenceFinding.updateMany).not.toHaveBeenCalled();
  });

  it('requires a snooze expiry, and refuses one in the past', async () => {
    const { svc } = build([open('f1')]);
    await expect(svc.apply('snooze', ['f1'], 'u1')).rejects.toThrow(/expiry/i);
    // A past expiry reads as "already elapsed" and would silently do nothing.
    const past = new Date(Date.now() - 1000).toISOString();
    await expect(svc.apply('snooze', ['f1'], 'u1', { snoozedUntil: past })).rejects.toThrow(/future/i);
  });

  it('stores an absolute snooze instant', async () => {
    const { svc, calls } = build([open('f1')]);
    await svc.apply('snooze', ['f1'], 'u1', { snoozedUntil: FUTURE });
    expect((calls.updates[0].data as Row).snoozedUntil).toEqual(new Date(FUTURE));
  });

  it('clears the escalation marker when a person decides', async () => {
    const { svc, calls } = build([open('f1', { escalationReason: 'severity_increased' })]);
    await svc.apply('acknowledge', ['f1'], 'u1');
    expect((calls.updates[0].data as Row).escalationReason).toBeNull();
  });

  it('recomputes the ordering rank for the new disposition', async () => {
    const { svc, calls } = build([open('f1', { severity: 'critical' })]);
    await svc.apply('acknowledge', ['f1'], 'u1');
    // critical + acknowledged === 1, per the documented formula.
    expect((calls.updates[0].data as Row).attentionPriority).toBe(1);
  });

  it('groups by severity so each row gets its own correct rank', async () => {
    const { svc, calls } = build([open('f1', { severity: 'critical' }), open('f2', { severity: 'info' })]);
    await svc.apply('acknowledge', ['f1', 'f2'], 'u1');
    const ranks = calls.updates.map((u) => (u.data as Row).attentionPriority).sort();
    expect(ranks).toEqual([1, 41]);
  });

  it('resets a disposition back to unreviewed and forgets the actor', async () => {
    const { svc, calls } = build([open('f1', { disposition: 'dismissed' })]);
    await svc.apply('reset', ['f1'], 'u1');
    const data = calls.updates[0].data as Row;
    expect(data.disposition).toBe('unreviewed');
    expect(data.dispositionBy).toBeNull();
    expect(data.dispositionAt).toBeNull();
  });

  it('records one history row per finding, naming the actor', async () => {
    const { svc, calls } = build([open('f1'), open('f2')]);
    await svc.apply('dismiss', ['f1', 'f2'], 'u1');
    expect(calls.history).toHaveLength(2);
    expect(calls.history[0]).toMatchObject({ event: 'dismissed', actorUserId: 'u1' });
    expect((calls.history[0].detail as Row).from).toBe('unreviewed');
  });

  it('rejects an empty selection', async () => {
    const { svc } = build([]);
    await expect(svc.apply('acknowledge', [], 'u1')).rejects.toThrow(/no findings/i);
  });
});
