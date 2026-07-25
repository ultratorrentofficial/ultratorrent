import { NotFoundException } from '@nestjs/common';
import { NotificationInboxService } from './inbox.service';

function build(rows: any[] = [], deliveries: any[] = []) {
  const match = (r: any, where: any): boolean => {
    if (where.userId && r.userId !== where.userId) return false;
    if (where.id && r.id !== where.id) return false;
    if ('readAt' in where) {
      if (where.readAt === null && r.readAt !== null) return false;
      if (where.readAt?.not === null && r.readAt === null) return false;
    }
    if ('archivedAt' in where) {
      if (where.archivedAt === null && r.archivedAt !== null) return false;
      if (where.archivedAt?.not === null && r.archivedAt === null) return false;
    }
    if (where.category && r.category !== where.category) return false;
    if (where.severity && r.severity !== where.severity) return false;
    if (where.eventKey && r.eventKey !== where.eventKey) return false;
    if (where.OR) {
      const q = where.OR[0].title.contains.toLowerCase();
      if (!`${r.title} ${r.body ?? ''}`.toLowerCase().includes(q)) return false;
    }
    return true;
  };
  const prisma = {
    userNotification: {
      findMany: jest.fn(async ({ where, skip = 0, take = 25 }: any) =>
        rows.filter((r) => match(r, where)).slice(skip, skip + take)),
      count: jest.fn(async ({ where }: any) => rows.filter((r) => match(r, where)).length),
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => match(r, where)) ?? null),
      update: jest.fn(async ({ where, data }: any) => {
        const r = rows.find((x) => x.id === where.id);
        Object.assign(r, data);
        return r;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      }),
    },
    userNotificationDelivery: {
      findMany: jest.fn(async ({ where }: any) =>
        deliveries.filter((d) => d.userId === where.userId && where.notificationId.in.includes(d.notificationId))),
    },
  };
  return { svc: new NotificationInboxService(prisma as any), prisma, rows };
}

const note = (over: any = {}) => ({
  id: 'n1', userId: 'me', eventKey: 'download.torrent_completed', category: 'downloads',
  severity: 'success', title: 'Dune', body: null, deepLink: '/torrents',
  readAt: null, archivedAt: null, groupCount: 1,
  lastAt: new Date('2026-07-25T00:00:00Z'), createdAt: new Date('2026-07-25T00:00:00Z'),
  ...over,
});

describe('NotificationInboxService', () => {
  it('lists only this user’s notifications', async () => {
    const { svc } = build([note(), note({ id: 'n2', userId: 'other' })]);
    const r = await svc.list('me');
    expect(r.items.map((i) => i.id)).toEqual(['n1']);
    expect(r.total).toBe(1);
  });

  it('hides archived items by default', async () => {
    const { svc } = build([note(), note({ id: 'n2', archivedAt: new Date() })]);
    expect((await svc.list('me')).items.map((i) => i.id)).toEqual(['n1']);
  });

  it('shows archived only when asked', async () => {
    const { svc } = build([note(), note({ id: 'n2', archivedAt: new Date(), readAt: new Date() })]);
    expect((await svc.list('me', { state: 'archived' })).items.map((i) => i.id)).toEqual(['n2']);
  });

  it('filters unread and read', async () => {
    const { svc } = build([note(), note({ id: 'n2', readAt: new Date() })]);
    expect((await svc.list('me', { state: 'unread' })).items.map((i) => i.id)).toEqual(['n1']);
    expect((await svc.list('me', { state: 'read' })).items.map((i) => i.id)).toEqual(['n2']);
  });

  it('filters by category, severity and event', async () => {
    const { svc } = build([note(), note({ id: 'n2', category: 'security', severity: 'critical', eventKey: 'system.security_alert' })]);
    expect((await svc.list('me', { category: 'security' })).items.map((i) => i.id)).toEqual(['n2']);
    expect((await svc.list('me', { severity: 'critical' })).items.map((i) => i.id)).toEqual(['n2']);
    expect((await svc.list('me', { eventKey: 'system.security_alert' })).items.map((i) => i.id)).toEqual(['n2']);
  });

  it('searches title and body', async () => {
    const { svc } = build([note(), note({ id: 'n2', title: 'Arrival', body: 'a film' })]);
    expect((await svc.list('me', { search: 'arriv' })).items.map((i) => i.id)).toEqual(['n2']);
  });

  it('paginates and caps the page size', async () => {
    const many = Array.from({ length: 40 }, (_, i) => note({ id: `n${i}` }));
    const { svc } = build(many);
    const p1 = await svc.list('me', { page: '1', pageSize: '10' });
    expect(p1.items).toHaveLength(10);
    expect(p1.total).toBe(40);
    const capped = await svc.list('me', { pageSize: '5000' });
    expect(capped.pageSize).toBe(100);
  });

  it('attaches per-channel delivery outcomes in ONE query', async () => {
    const { svc, prisma } = build(
      [note(), note({ id: 'n2' })],
      [
        { notificationId: 'n1', userId: 'me', channelType: 'telegram', status: 'provider_accepted' },
        { notificationId: 'n1', userId: 'me', channelType: 'email', status: 'failed' },
      ],
    );
    const r = await svc.list('me');
    expect(r.items[0].deliveries).toHaveLength(2);
    expect(prisma.userNotificationDelivery.findMany).toHaveBeenCalledTimes(1); // not per row
  });

  it('counts unread excluding archived — what the bell shows', async () => {
    const { svc } = build([
      note(),
      note({ id: 'n2' }),
      note({ id: 'n3', readAt: new Date() }),
      note({ id: 'n4', archivedAt: new Date() }),
    ]);
    expect(await svc.unreadCount('me')).toEqual({ unread: 2 });
  });

  describe('ownership', () => {
    it("refuses another user's notification as NOT FOUND", async () => {
      const { svc } = build([note({ userId: 'other' })]);
      await expect(svc.setRead('me', 'n1', true)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('uses the same response for missing and foreign', async () => {
      const { svc } = build([note({ userId: 'other' })]);
      const foreign = await svc.archive('me', 'n1').catch((e) => e.message);
      const missing = await svc.archive('me', 'nope').catch((e) => e.message);
      expect(foreign).toBe(missing);
    });
  });

  it('marks read and unread', async () => {
    const { svc, rows } = build([note()]);
    expect(await svc.setRead('me', 'n1', true)).toMatchObject({ read: true });
    expect(rows[0].readAt).toBeInstanceOf(Date);
    expect(await svc.setRead('me', 'n1', false)).toMatchObject({ read: false });
    expect(rows[0].readAt).toBeNull();
  });

  it('archiving also marks read, so the bell does not stay lit', async () => {
    const { svc, rows } = build([note()]);
    await svc.archive('me', 'n1');
    expect(rows[0].archivedAt).toBeInstanceOf(Date);
    expect(rows[0].readAt).toBeInstanceOf(Date);
  });

  it('marks all read for this user only', async () => {
    const { svc, rows } = build([note(), note({ id: 'n2' }), note({ id: 'n3', userId: 'other' })]);
    expect(await svc.markAllRead('me')).toEqual({ updated: 2 });
    expect(rows.find((r) => r.id === 'n3')!.readAt).toBeNull(); // untouched
  });

  it('archives read items in bulk', async () => {
    const { svc } = build([note({ readAt: new Date() }), note({ id: 'n2' })]);
    expect(await svc.archiveRead('me')).toEqual({ archived: 1 });
  });
});
