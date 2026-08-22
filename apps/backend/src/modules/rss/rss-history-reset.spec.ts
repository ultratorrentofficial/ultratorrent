/**
 * Clearing a downloaded history item, when the release is still in the client.
 *
 * Re-adding an info-hash the engine already holds is a silent no-op — the exact
 * way the first version of this action failed in the field. So the reset tears
 * the live copy down COMPLETELY (torrent, payload, imported library items,
 * intake jobs) before marking anything for re-grab, and refuses to do so
 * without the authority that destroying media requires.
 */
import { ForbiddenException } from '@nestjs/common';
import { RssService } from './rss.module';
import { TorrentsService } from '../torrents/torrents.service';
import { MediaIntakeService } from '../media-intake/media-intake.service';

const HASH = '18ba9c39b70783930671ad9a01300ffc88e557a0';

function build(opts: { live?: boolean; rows?: any[] } = {}) {
  const rows = opts.rows ?? [
    { id: 'h1', feedId: 'f1', title: 'Lanterns S01E01', infoHash: HASH, downloaded: true },
  ];
  const updates: any[] = [];
  const prisma = {
    rssHistory: {
      findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
      update: async (args: any) => {
        updates.push({ kind: 'update', ...args });
        return rows[0];
      },
      updateMany: async (args: any) => {
        updates.push({ kind: 'updateMany', ...args });
        return { count: rows.length };
      },
    },
    rssAcquisition: { deleteMany: async () => ({ count: 1 }) },
    torrentSnapshot: {
      findFirst: async () => (opts.live ? { hash: HASH, engineId: 'eng1' } : null),
    },
  };
  const removeData = jest.fn(async () => ({ success: true, libraryItemsRemoved: 2 }));
  const supersedeByHash = jest.fn(async () => 1);
  const moduleRef = {
    get: (token: any) => {
      if (token === TorrentsService) return { removeData };
      if (token === MediaIntakeService) return { supersedeByHash };
      throw new Error(`unexpected token ${token?.name}`);
    },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const svc = new RssService(
    prisma as any, {} as any, {} as any, audit as any, {} as any, moduleRef as any,
    { get: async () => null, defaultProfile: async () => null } as any,
    {} as any, {} as any,
  );
  return { svc, prisma, removeData, supersedeByHash, audit, updates };
}

describe('resetHistoryItem with the torrent still in the client', () => {
  it('tears down the torrent, its data AND the imported library items', async () => {
    const { svc, removeData, supersedeByHash } = build({ live: true });
    const res = await svc.resetHistoryItem('h1', { userId: 'u1' }, { canDeleteData: true });

    expect(removeData).toHaveBeenCalledWith(
      HASH, 'eng1', expect.anything(), expect.anything(),
      { removeLibraryItems: true },
    );
    expect(supersedeByHash).toHaveBeenCalledWith(HASH, expect.any(String));
    expect(res.torrentRemoved).toBe(true);
    expect(res.libraryItemsRemoved).toBe(2);
  });

  it('refuses without torrents.delete_data, and resets nothing', async () => {
    // The grant that manages feeds must not silently include the one that
    // destroys media — and a refused reset must leave the row untouched, or
    // the status would read cleared while the torrent still vetoes the re-add.
    const { svc, removeData, updates } = build({ live: true });
    await expect(
      svc.resetHistoryItem('h1', { userId: 'u1' }, { canDeleteData: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(removeData).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  it('supersedes the intake jobs even when the torrent is already gone', async () => {
    // The stale job holds the idempotency key: a re-grab of the same hash to
    // the same path derives the same key, and enqueue would answer with the
    // finished job and import nothing.
    const { svc, removeData, supersedeByHash } = build({ live: false });
    const res = await svc.resetHistoryItem('h1', { userId: 'u1' }, { canDeleteData: false });
    expect(removeData).not.toHaveBeenCalled();
    expect(supersedeByHash).toHaveBeenCalledWith(HASH, expect.any(String));
    expect(res.torrentRemoved).toBe(false);
  });

  it('clears every history row carrying the info-hash, not just the clicked one', async () => {
    // The cross-feed dedupe refuses any hash SOME row records as downloaded, so
    // a twin row from another feed would silently veto the re-grab.
    const { svc, updates } = build({ live: false });
    await svc.resetHistoryItem('h1', {}, {});
    const um = updates.find((u) => u.kind === 'updateMany');
    expect(um.where).toEqual({ infoHash: HASH });
    expect(um.data).toMatchObject({ downloaded: false, regrabRequestedAt: expect.any(Date) });
  });

  it('falls back to the single row when the item has no info-hash', async () => {
    const { svc, updates, supersedeByHash } = build({
      rows: [{ id: 'h1', feedId: 'f1', title: 'x', infoHash: null, downloaded: true }],
    });
    await svc.resetHistoryItem('h1', {}, {});
    expect(supersedeByHash).not.toHaveBeenCalled();
    const u = updates.find((x) => x.kind === 'update');
    expect(u.where).toEqual({ id: 'h1' });
  });
});

describe('MediaIntakeService.supersedeByHash', () => {
  it('archives the jobs and frees their idempotency keys', async () => {
    const jobs = [
      { id: 'j1', state: 'seeding', idempotencyKey: 'eng1:hash:/downloads/Intake/x' },
    ];
    const updated: any[] = [];
    const events: any[] = [];
    const prisma = {
      mediaIntakeJob: {
        findMany: async () => jobs,
        update: async (args: any) => { updated.push(args); return {}; },
      },
      mediaIntakeEvent: { create: async ({ data }: any) => { events.push(data); return {}; } },
    };
    const svc = new MediaIntakeService(prisma as any);
    const n = await svc.supersedeByHash('hash', 'why');

    expect(n).toBe(1);
    expect(updated[0].data.state).toBe('archived');
    // The freed key must stay unique AND differ from the derivable one, or the
    // next enqueue for the same payload would still collide with this job.
    expect(updated[0].data.idempotencyKey).toBe('eng1:hash:/downloads/Intake/x::superseded:j1');
    expect(events[0]).toMatchObject({ jobId: 'j1', fromState: 'seeding', toState: 'archived' });
  });
});
