/**
 * An expired quarantine item is eventually removed.
 *
 * Expiry used to be the end of the line: the sweep marked an item `expired` and
 * it then sat in `.ultratorrent-quarantine/` forever — renamed with an id
 * prefix, so hard to identify by hand — waiting for a human with no reason to
 * look. That is the same unbounded growth the trash sweep exists to prevent,
 * and "retain for N days" cannot mean "keep indefinitely" in one subsystem
 * while meaning "purge" in the other.
 */
import { QuarantineService } from './quarantine.service';

const DAY = 86_400_000;

function build(opts: { rows?: Array<Record<string, unknown>>; grace?: number; protected?: boolean } = {}) {
  const rows = opts.rows ?? [];
  const updates: Array<Record<string, unknown>> = [];
  const removed: string[] = [];
  const prisma = {
    mediaCleanupQuarantineItem: {
      updateMany: jest.fn(async () => ({ count: 0 })),
      findMany: jest.fn(
        async (_args?: { where?: { status?: string; restoreDeadline?: { lte?: Date } } }) => rows,
      ),
      update: jest.fn(async (args: never) => {
        updates.push(args as Record<string, unknown>);
        return {};
      }),
    },
  };
  const audit = { record: jest.fn(async (_entry?: { userId?: string }) => undefined) };
  const protections = {
    evaluate: jest.fn(async () => ({ isProtected: Boolean(opts.protected), hasLegalHold: false })),
  };
  const settings = { get: jest.fn(async () => opts.grace ?? 7) };
  const svc = new QuarantineService(
    prisma as never, audit as never, { hardRoots: ['/data'] } as never,
    protections as never, {} as never, settings as never,
  );
  // The payload guard and the unlink are filesystem concerns; this spec is
  // about WHICH rows the sweep decides to remove.
  (svc as never as { payloadIsRemovable: () => boolean }).payloadIsRemovable = () => true;
  (svc as never as { removePayload: (r: { id: string }) => Promise<unknown> }).removePayload =
    async (r) => { removed.push(r.id); return {}; };
  return { svc, prisma, audit, protections, removed };
}

const expired = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  status: 'expired',
  originalPath: '/data/Movies/Film (2020)/Film.mkv',
  quarantinePath: '/data/.ultratorrent-quarantine/q1__Film.mkv',
  storageRoot: '/data',
  fileSizeBytes: BigInt(10),
  mediaItemId: 'item-1',
  mediaFileId: null,
  restoreDeadline: new Date(Date.now() - 30 * DAY),
  ...over,
});

describe('quarantine auto-purge after grace', () => {
  it('removes an expired item once its grace has elapsed', async () => {
    const { svc, removed } = build({ rows: [expired()] });
    await svc.sweepExpired();
    expect(removed).toEqual(['q1']);
  });

  it('asks only for items whose deadline is older than the grace window', async () => {
    const { svc, prisma } = build({ rows: [], grace: 7 });
    await svc.sweepExpired();
    const where = prisma.mediaCleanupQuarantineItem.findMany.mock.calls[0]?.[0]?.where ?? {};
    expect(where.status).toBe('expired');
    // ~7 days ago, not "now" — the grace is what separates expiry from removal.
    const ageDays = (Date.now() - (where.restoreDeadline?.lte as Date).getTime()) / DAY;
    expect(ageDays).toBeCloseTo(7, 1);
  });

  it('purges as soon as it expires when grace is zero', async () => {
    // Same reading of zero as the trash sweep: keep it for zero days.
    const { svc, prisma } = build({ rows: [], grace: 0 });
    await svc.sweepExpired();
    const where = prisma.mediaCleanupQuarantineItem.findMany.mock.calls[0]?.[0]?.where ?? {};
    expect(Date.now() - (where.restoreDeadline?.lte as Date).getTime()).toBeLessThan(2000);
  });

  it('keeps a protected item and removes nothing', async () => {
    // A hold placed while the item sat here must still save it — and a sweep is
    // exactly when nobody is watching.
    const { svc, removed, audit } = build({ rows: [expired()], protected: true });
    await svc.sweepExpired();
    expect(removed).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records the removal with no user, because nobody pressed anything', async () => {
    const { svc, audit } = build({ rows: [expired()] });
    await svc.sweepExpired();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'library_cleanup.quarantine.auto_purged',
        metadata: expect.objectContaining({ graceDays: 7 }),
      }),
    );
    expect(audit.record.mock.calls[0]?.[0]?.userId).toBeUndefined();
  });

  it('keeps sweeping when one item cannot be removed', async () => {
    const { svc, removed, audit } = build({ rows: [expired({ id: 'bad' }), expired({ id: 'q2' })] });
    (svc as never as { removePayload: (r: { id: string }) => Promise<unknown> }).removePayload =
      async (r) => {
        if (r.id === 'bad') throw new Error('busy mount');
        removed.push(r.id);
        return {};
      };

    await svc.sweepExpired();

    expect(removed).toEqual(['q2']);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});
