import { TransferLedgerService } from './transfer-ledger.service';

/**
 * The parts of the ledger that touch a database or an engine.
 *
 * The arithmetic is covered in `domain/accrual.spec.ts`; what matters here is
 * the seeding decision — where an engine's starting number comes from, and when
 * we refuse to guess one.
 */
function build(opts: {
  ledgerRow?: Record<string, unknown> | null;
  allTime?: { downloaded: bigint; uploaded: bigint } | null;
  allTimeThrows?: boolean;
  torrents?: Array<{ hash: string; downloaded: number; uploaded: number }>;
  snapshots?: Array<Record<string, unknown>>;
} = {}) {
  const upserts: any[] = [];
  const created: any[] = [];
  const prisma = {
    transferLedger: {
      findUnique: jest.fn(async () => opts.ledgerRow ?? null),
      findMany: jest.fn(async () => (opts.ledgerRow ? [opts.ledgerRow] : [])),
      upsert: jest.fn(async (a: any) => { upserts.push(a); return a; }),
    },
    torrentSnapshot: {
      findMany: jest.fn(async () => opts.snapshots ?? []),
    },
    retiredTorrentTransfer: {
      createMany: jest.fn(async (a: any) => { created.push(a); return { count: 0 }; }),
    },
  };
  const provider: any = {
    engineId: 'e1',
    listTorrents: jest.fn(async () => opts.torrents ?? []),
  };
  if (opts.allTimeThrows) {
    provider.getAllTimeStats = jest.fn(async () => { throw new Error('nope'); });
  } else if (opts.allTime !== undefined) {
    provider.getAllTimeStats = jest.fn(async () => opts.allTime);
  }
  return { svc: new TransferLedgerService(prisma as never), prisma, provider, upserts, created };
}

describe('seeding an engine baseline', () => {
  it('takes the engine all-time counter when it has one', async () => {
    /*
     * The recovery case. A live install held 886 GiB of history in
     * qBittorrent's own counter while the app reported 41 GiB — adopting the
     * engine must not throw that away.
     */
    const { svc, provider, upserts } = build({
      allTime: { downloaded: 952_000_000_000n, uploaded: 328_000_000_000n },
    });
    await svc.ensureBaseline(provider);

    expect(upserts[0].create.baselineDownloaded).toBe(952_000_000_000n);
    expect(upserts[0].create.baselineUploaded).toBe(328_000_000_000n);
    expect(upserts[0].create.baselineSource).toBe('engine_alltime');
  });

  it('falls back to the current torrents when the engine has no such counter', async () => {
    // rTorrent's global totals reset with the daemon, so it declines to answer
    // rather than offer a session figure as lifetime history.
    const { svc, provider, upserts } = build({
      allTime: null,
      torrents: [
        { hash: 'a', downloaded: 1_000, uploaded: 400 },
        { hash: 'b', downloaded: 2_500, uploaded: 100 },
      ],
    });
    await svc.ensureBaseline(provider);

    expect(upserts[0].create.baselineDownloaded).toBe(3_500n);
    expect(upserts[0].create.baselineUploaded).toBe(500n);
    expect(upserts[0].create.baselineSource).toBe('current_torrents');
  });

  it('uses the fallback for a provider that does not implement the method', async () => {
    const { svc, provider, upserts } = build({
      torrents: [{ hash: 'a', downloaded: 700, uploaded: 70 }],
    });
    expect(provider.getAllTimeStats).toBeUndefined();
    await svc.ensureBaseline(provider);

    expect(upserts[0].create.baselineDownloaded).toBe(700n);
    expect(upserts[0].create.baselineSource).toBe('current_torrents');
  });

  it('writes nothing when the engine cannot be reached', async () => {
    /*
     * A baseline is permanent, so a wrong one is permanent too. Leaving the row
     * unseeded and retrying next tick is the recoverable failure; banking zero
     * because the engine was briefly down is not.
     */
    const { svc, provider, upserts } = build({ allTimeThrows: true });
    await svc.ensureBaseline(provider);
    expect(upserts).toHaveLength(0);
  });

  it('does not re-seed an engine that already has a baseline', async () => {
    // Re-seeding would overwrite a figure that has since had months of accrual
    // measured against it.
    const { svc, provider, upserts } = build({
      ledgerRow: { baselineAt: new Date() },
      allTime: { downloaded: 5n, uploaded: 5n },
    });
    await svc.ensureBaseline(provider);
    expect(upserts).toHaveLength(0);
  });

  it('stops querying once an engine is settled', async () => {
    const { svc, provider, prisma } = build({ allTime: { downloaded: 1n, uploaded: 1n } });
    await svc.ensureBaseline(provider);
    await svc.ensureBaseline(provider);
    await svc.ensureBaseline(provider);

    // Only the first pass looks; the 2-second sync loop must not re-ask forever.
    expect(prisma.transferLedger.findUnique).toHaveBeenCalledTimes(1);
  });
});

describe('reporting totals', () => {
  it('adds the baseline to what has accrued since', async () => {
    const { svc } = build({
      ledgerRow: {
        baselineDownloaded: 1_000n, baselineUploaded: 400n,
        accruedDownloaded: 250n, accruedUploaded: 100n,
      },
    });
    const totals = await svc.totals('e1');

    expect(totals.downloaded).toBe(1_250n);
    expect(totals.uploaded).toBe(500n);
    expect(totals.ratio).toBeCloseTo(0.4, 6);
  });

  it('reports zero for an engine with no ledger yet', async () => {
    const { svc } = build();
    const totals = await svc.totals('e1');
    expect(totals.downloaded).toBe(0n);
    expect(totals.ratio).toBe(0);
  });
});

describe('archiving departed torrents', () => {
  it('records the ones the engine no longer lists', async () => {
    const { svc, created, prisma } = build({
      snapshots: [
        { hash: 'gone', name: 'Old.Release', downloaded: 900n, uploaded: 450n, ratio: 0.5, addedAt: null },
      ],
    });
    await svc.archiveRetired('e1', ['still-here']);

    // The query asks for exactly the complement of the live set.
    expect(prisma.torrentSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { engineId: 'e1', hash: { notIn: ['still-here'] } },
      }),
    );
    expect(created[0].data[0]).toMatchObject({ hash: 'gone', downloaded: 900n });
  });

  it('writes nothing when no torrent left', async () => {
    const { svc, created } = build({ snapshots: [] });
    await svc.archiveRetired('e1', ['a', 'b']);
    expect(created).toHaveLength(0);
  });

  it('never fails the sync it runs inside', async () => {
    // Provenance is worth having and not worth losing a tick of statistics for.
    const { svc, prisma } = build({ snapshots: [{ hash: 'x', name: 'n', downloaded: 1n, uploaded: 1n, ratio: 1, addedAt: null }] });
    prisma.retiredTorrentTransfer.createMany.mockRejectedValueOnce(new Error('constraint'));
    await expect(svc.archiveRetired('e1', [])).resolves.toBeUndefined();
  });
});
