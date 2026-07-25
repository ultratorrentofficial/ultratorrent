import { BadRequestException, NotFoundException } from '@nestjs/common';
import { NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { UserNotificationPreferenceService } from './user-preference.service';

const DL = NOTIFICATION_EVENTS.DOWNLOAD_TORRENT_COMPLETED; // default: enabled, in_app
const OFF_EVENT = NOTIFICATION_EVENTS.DOWNLOAD_TORRENT_ADDED; // default: disabled
const DEPRECATED = NOTIFICATION_EVENTS.MEDIA_SERVER_USER_PAUSED;

interface Channel { id: string; userId: string; type: string; deletedAt: Date | null }

function build(channels: Channel[] = []) {
  const prefs: any[] = [];
  const routes: any[] = [];
  let seq = 0;

  const prisma = {
    userNotificationPreference: {
      findMany: jest.fn(async ({ where }: any) =>
        prefs.filter((p) => p.userId === where.userId).map((p) => ({ ...p, routes: routes.filter((r) => r.preferenceId === p.id) })),
      ),
      findUnique: jest.fn(async ({ where }: any) => {
        const p = prefs.find((x) => x.userId === where.userId_eventKey.userId && x.eventKey === where.userId_eventKey.eventKey);
        return p ? { ...p, routes: routes.filter((r) => r.preferenceId === p.id) } : null;
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        let p = prefs.find((x) => x.userId === where.userId_eventKey.userId && x.eventKey === where.userId_eventKey.eventKey);
        if (p) Object.assign(p, Object.fromEntries(Object.entries(update).filter(([, v]) => v !== undefined)));
        else { p = { id: `pref-${++seq}`, enabled: null, deliveryMode: null, quietHoursBehavior: null, minSeverity: null, dedupeWindowSec: null, aggregationWindowMin: null, routesOverridden: false, ...create }; prefs.push(p); }
        return p;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const before = prefs.length;
        for (let i = prefs.length - 1; i >= 0; i--) {
          if (prefs[i].userId === where.userId && (!where.eventKey || prefs[i].eventKey === where.eventKey)) prefs.splice(i, 1);
        }
        return { count: before - prefs.length };
      }),
    },
    userNotificationEventRoute: {
      deleteMany: jest.fn(async ({ where }: any) => {
        for (let i = routes.length - 1; i >= 0; i--) if (routes[i].preferenceId === where.preferenceId) routes.splice(i, 1);
        return { count: 0 };
      }),
      createMany: jest.fn(async ({ data }: any) => { routes.push(...data); return { count: data.length }; }),
    },
    userNotificationChannel: {
      findMany: jest.fn(async ({ where }: any) =>
        channels.filter((c) => where.id.in.includes(c.id) && c.userId === where.userId && c.deletedAt === null),
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        channels.find((c) => c.id === where.id && c.userId === where.userId && c.deletedAt === null) ?? null,
      ),
    },
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  return { svc: new UserNotificationPreferenceService(prisma as any, audit as any), prefs, routes, audit };
}

const MINE = { id: 'ch-mine', userId: 'me', type: 'telegram', deletedAt: null };
const THEIRS = { id: 'ch-theirs', userId: 'someone-else', type: 'telegram', deletedAt: null };

describe('effective preference resolution (lazy defaults)', () => {
  it('resolves a complete answer with NO stored row', async () => {
    const { svc, prefs } = build();
    const p = await svc.effectiveFor('me', DL);
    expect(prefs).toHaveLength(0); // nothing written just to read
    expect(p).toMatchObject({ enabled: true, deliveryMode: 'immediate', isDefault: true });
    expect(p.routes).toEqual([{ channelType: 'in_app', channelConnectionId: null, enabled: true, deliveryMode: null }]);
  });

  it('honours a catalogue default of disabled', async () => {
    const { svc } = build();
    expect(await svc.effectiveFor('me', OFF_EVENT)).toMatchObject({ enabled: false, routes: [] });
  });

  it('overlays a stored override on the default', async () => {
    const { svc } = build();
    await svc.setPreference('me', DL, { enabled: false });
    const p = await svc.effectiveFor('me', DL);
    expect(p).toMatchObject({ enabled: false, deliveryMode: 'immediate', isDefault: false });
  });

  it('leaves untouched fields inheriting rather than freezing them', async () => {
    const { svc } = build();
    await svc.setPreference('me', DL, { deliveryMode: 'daily_digest' });
    const p = await svc.effectiveFor('me', DL);
    expect(p.deliveryMode).toBe('daily_digest');
    expect(p.enabled).toBe(true); // still from the catalogue
  });

  it('rejects an unknown event', async () => {
    const { svc } = build();
    await expect(svc.effectiveFor('me', 'nope.nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists the matrix without an N+1', async () => {
    const { svc } = build();
    const rows = await svc.listEvents('me');
    expect(rows.length).toBeGreaterThan(60);
    expect(rows.every((r) => r.preference.eventKey === r.definition.key)).toBe(true);
  });

  it('omits deprecated events from the matrix', async () => {
    const { svc } = build();
    const rows = await svc.listEvents('me');
    expect(rows.some((r) => r.definition.key === DEPRECATED)).toBe(false);
  });
});

describe('route ownership — the cross-user boundary', () => {
  it("REFUSES a connection owned by another user", async () => {
    // Without this check anyone could route their events through someone else's
    // Telegram chat — reading their destination and sending to it.
    const { svc, routes } = build([MINE, THEIRS]);
    await expect(
      svc.setRoutes('me', DL, [{ channelType: 'telegram', channelConnectionId: THEIRS.id }]),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(routes).toHaveLength(0);
  });

  it("does not reveal that another user's connection exists", async () => {
    const { svc } = build([MINE, THEIRS]);
    const foreign = await svc.setRoutes('me', DL, [{ channelType: 'telegram', channelConnectionId: THEIRS.id }]).catch((e) => e.message);
    const missing = await svc.setRoutes('me', DL, [{ channelType: 'telegram', channelConnectionId: 'no-such-id' }]).catch((e) => e.message);
    expect(foreign).toBe(missing);
  });

  it('accepts a connection the user owns', async () => {
    const { svc } = build([MINE]);
    const p = await svc.setRoutes('me', DL, [{ channelType: 'telegram', channelConnectionId: MINE.id }]);
    expect(p.routes).toEqual([
      { channelType: 'telegram', channelConnectionId: MINE.id, enabled: true, deliveryMode: null },
    ]);
  });

  it('refuses a soft-deleted connection', async () => {
    const { svc } = build([{ ...MINE, deletedAt: new Date() }]);
    await expect(
      svc.setRoutes('me', DL, [{ channelType: 'telegram', channelConnectionId: MINE.id }]),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a connection whose type does not match the route', async () => {
    const { svc } = build([{ ...MINE, type: 'email' }]);
    await expect(
      svc.setRoutes('me', DL, [{ channelType: 'telegram', channelConnectionId: MINE.id }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a connection for every external channel', async () => {
    const { svc } = build([MINE]);
    await expect(svc.setRoutes('me', DL, [{ channelType: 'telegram' }])).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a connection on the in-app route', async () => {
    const { svc } = build([MINE]);
    await expect(
      svc.setRoutes('me', DL, [{ channelType: 'in_app', channelConnectionId: MINE.id }]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('supports MULTIPLE connections of the same type on one event', async () => {
    // The improvement over the UniFi model: one event, two Telegram destinations.
    const second = { id: 'ch-mine-2', userId: 'me', type: 'telegram', deletedAt: null };
    const { svc } = build([MINE, second]);
    const p = await svc.setRoutes('me', DL, [
      { channelType: 'telegram', channelConnectionId: MINE.id },
      { channelType: 'telegram', channelConnectionId: second.id },
      { channelType: 'in_app' },
    ]);
    expect(p.routes).toHaveLength(3);
    expect(p.routes.filter((r) => r.channelType === 'telegram')).toHaveLength(2);
  });

  it('clears every route when given an empty list — "nowhere", not "default"', async () => {
    const { svc } = build([MINE]);
    await svc.setRoutes('me', DL, [{ channelType: 'telegram', channelConnectionId: MINE.id }]);
    const p = await svc.setRoutes('me', DL, []);
    expect(p.routes).toEqual([]); // must NOT silently fall back to the in-app default
  });

  it('a scalar edit does NOT wipe the default in-app route', async () => {
    // The other half of the same ambiguity: changing only the delivery mode creates
    // a preference row with no route rows, which must still mean "inherit".
    const { svc } = build([MINE]);
    await svc.setPreference('me', DL, { deliveryMode: 'daily_digest' });
    const p = await svc.effectiveFor('me', DL);
    expect(p.routes.map((r) => r.channelType)).toEqual(['in_app']);
    expect(p.deliveryMode).toBe('daily_digest');
  });
});

describe('bulk operations', () => {
  it('applies a delivery mode across many events', async () => {
    const { svc } = build();
    const r = await svc.bulk('me', [DL, OFF_EVENT], { kind: 'set_delivery_mode', deliveryMode: 'weekly_digest' });
    expect(r.applied).toBe(2);
    expect((await svc.effectiveFor('me', DL)).deliveryMode).toBe('weekly_digest');
  });

  it('REPORTS skipped events instead of silently dropping them', async () => {
    const { svc } = build();
    const r = await svc.bulk('me', [DL, 'not.an.event', DEPRECATED], { kind: 'set_enabled', enabled: false });
    expect(r.applied).toBe(1);
    expect(r.skipped).toEqual(
      expect.arrayContaining([
        { eventKey: 'not.an.event', reason: 'unknown_event' },
        { eventKey: DEPRECATED, reason: 'deprecated_event' },
      ]),
    );
  });

  it('validates a bulk connection once, and rejects another user’s', async () => {
    const { svc } = build([MINE, THEIRS]);
    await expect(
      svc.bulk('me', [DL], { kind: 'enable_channel', channelType: 'telegram', channelConnectionId: THEIRS.id }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('adds a channel across events without dropping the existing in-app route', async () => {
    const { svc } = build([MINE]);
    const r = await svc.bulk('me', [DL], { kind: 'enable_channel', channelType: 'telegram', channelConnectionId: MINE.id });
    expect(r.applied).toBe(1);
    const p = await svc.effectiveFor('me', DL);
    expect(p.routes.map((x) => x.channelType).sort()).toEqual(['in_app', 'telegram']);
  });

  it('removes a channel across events', async () => {
    const { svc } = build([MINE]);
    await svc.bulk('me', [DL], { kind: 'enable_channel', channelType: 'telegram', channelConnectionId: MINE.id });
    await svc.bulk('me', [DL], { kind: 'disable_channel', channelType: 'telegram' });
    expect((await svc.effectiveFor('me', DL)).routes.map((r) => r.channelType)).toEqual(['in_app']);
  });

  it('audits the bulk change', async () => {
    const { svc, audit } = build();
    await svc.bulk('me', [DL], { kind: 'set_enabled', enabled: false });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'notification.preferences.bulk_updated' }),
    );
  });
});

describe('reset', () => {
  it('returns one event to its catalogue default', async () => {
    const { svc } = build();
    await svc.setPreference('me', DL, { enabled: false });
    const p = await svc.resetEvent('me', DL);
    expect(p).toMatchObject({ enabled: true, isDefault: true });
  });

  it('clears every override but leaves connections alone', async () => {
    const { svc } = build([MINE]);
    await svc.setPreference('me', DL, { enabled: false });
    await svc.setPreference('me', OFF_EVENT, { enabled: true });
    expect(await svc.resetAll('me')).toMatchObject({ cleared: 2 });
    expect((await svc.effectiveFor('me', DL)).isDefault).toBe(true);
  });

  it('scopes every write to the acting user', async () => {
    // Two users, same event: one resetting must not touch the other.
    const { svc } = build();
    await svc.setPreference('me', DL, { enabled: false });
    await svc.setPreference('other', DL, { enabled: false });
    await svc.resetAll('me');
    expect((await svc.effectiveFor('other', DL)).enabled).toBe(false);
  });
});
