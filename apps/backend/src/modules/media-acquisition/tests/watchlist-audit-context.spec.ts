import { AcquisitionWatchlistService } from '../watchlist.service';
import { ImdbSeriesResolver } from '../imdb-series-resolver.service';
import { reqAuditContext } from '../../../common/request-audit-context';

/**
 * Every watchlist write must record WHERE it came from, not just who claimed to
 * make it.
 *
 * The gap this covers: a bulk add of 244 shows on 2026-07-29 wrote 244 audit rows
 * carrying a user id and a null `ipAddress`/`userAgent`, because `create` never
 * accepted a request context to begin with. Asking afterwards which address had
 * queued eleven days of automated downloads was unanswerable from the log — the
 * nearest attributable action was thirteen minutes later, on a different address
 * than the same account had used that morning.
 */
function build() {
  const prisma = {
    mediaAcquisitionWatchlistItem: {
      create: jest.fn().mockImplementation(({ data }: any) => ({ id: 'w1', ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => ({ id: 'w1', ...data })),
      findUnique: jest.fn().mockResolvedValue({ id: 'w1', title: 'Resident Alien', externalIds: null }),
      findMany: jest.fn().mockResolvedValue([]),
      delete: jest.fn().mockResolvedValue({}),
    },
    wantedEpisode: { deleteMany: jest.fn().mockResolvedValue({}) },
    wantedMovie: { deleteMany: jest.fn().mockResolvedValue({}) },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const realtime = { broadcast: jest.fn() };
  const moduleRef = { get: jest.fn() };
  const resolver = new ImdbSeriesResolver(prisma as any);
  const svc = new AcquisitionWatchlistService(
    prisma as any, audit as any, realtime as any, moduleRef as any, resolver,
  );
  return { svc, audit };
}

const CTX = { ipAddress: '38.158.215.237', userAgent: 'Mozilla/5.0 (Macintosh)' };
const rowFor = (audit: any, action: string) =>
  audit.record.mock.calls.map((c: any[]) => c[0]).find((e: any) => e.action === action);

describe('watchlist writes carry the request context into the audit log', () => {
  it('records the caller address on a single add', async () => {
    const { svc, audit } = build();

    await svc.create({ type: 'series', title: 'Resident Alien' } as any, 'u1', CTX);

    expect(rowFor(audit, 'media_acquisition.watchlist.created')).toMatchObject({
      userId: 'u1',
      ipAddress: '38.158.215.237',
      userAgent: 'Mozilla/5.0 (Macintosh)',
    });
  });

  it('records it on a BULK add — the shape that actually went unattributed', async () => {
    const { svc, audit } = build();

    await svc.bulkCreate(
      [{ title: 'Resident Alien' }, { title: 'Scandal' }],
      'u1',
      CTX,
    );

    const rows = audit.record.mock.calls
      .map((c: any[]) => c[0])
      .filter((e: any) => e.action === 'media_acquisition.watchlist.created');
    expect(rows).toHaveLength(2);
    // Every row, not just the first: the bulk path fans out through `create`,
    // and a context threaded only into the first call would look correct in a
    // spot check while leaving 243 of 244 rows anonymous.
    for (const row of rows) expect(row.ipAddress).toBe('38.158.215.237');
  });

  it('records it on update and delete', async () => {
    const { svc, audit } = build();

    await svc.update('w1', { priority: 50 }, 'u1', CTX);
    await svc.remove('w1', 'u1', CTX);

    expect(rowFor(audit, 'media_acquisition.watchlist.updated')).toMatchObject(CTX);
    expect(rowFor(audit, 'media_acquisition.watchlist.deleted')).toMatchObject(CTX);
  });

  it('still writes a row when there is no context to record', async () => {
    const { svc, audit } = build();

    await svc.create({ type: 'series', title: 'Resident Alien' } as any, 'u1');

    // Auditing must never depend on the context being present — an internal
    // caller with no HTTP request behind it still has to leave a trace.
    const row = rowFor(audit, 'media_acquisition.watchlist.created');
    expect(row).toMatchObject({ userId: 'u1' });
    expect(row.ipAddress).toBeUndefined();
  });
});

describe('reqAuditContext', () => {
  it('prefers x-forwarded-for over the proxy address', () => {
    const req = { headers: { 'x-forwarded-for': '38.158.215.237', 'user-agent': 'UA' }, ip: '172.18.0.1' };
    expect(reqAuditContext(req as any)).toEqual({ ipAddress: '38.158.215.237', userAgent: 'UA' });
  });

  it('falls back to req.ip when the header is absent', () => {
    const req = { headers: { 'user-agent': 'UA' }, ip: '192.168.99.178' };
    expect(reqAuditContext(req as any)).toEqual({ ipAddress: '192.168.99.178', userAgent: 'UA' });
  });
});
