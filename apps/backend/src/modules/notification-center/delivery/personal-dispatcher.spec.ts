import { NOTIFICATION_EVENTS } from '@ultratorrent/shared';
import { PersonalNotificationDispatcher } from './personal-dispatcher.service';

const DL = NOTIFICATION_EVENTS.DOWNLOAD_TORRENT_COMPLETED; // enabled, in_app by default

/**
 * Harness over the dispatcher's collaborators. The preference service is stubbed
 * per user so two people can genuinely disagree about the same event, which is the
 * property the whole engine exists to provide.
 */
function build(opts: {
  recipients?: string[];
  prefs?: Record<string, any>;
  connections?: any[];
  profiles?: Record<string, any>;
} = {}) {
  const deliveries: any[] = [];
  const inApp: any[] = [];
  const emitted: any[] = [];

  const prisma = {
    userNotificationProfile: {
      findUnique: jest.fn(async ({ where }: any) => opts.profiles?.[where.userId] ?? null),
    },
    userNotificationChannel: {
      findFirst: jest.fn(async ({ where }: any) =>
        (opts.connections ?? []).find((c) => c.id === where.id && c.userId === where.userId && c.deletedAt === null) ?? null,
      ),
    },
    userNotification: {
      findFirst: jest.fn(async ({ where }: any) =>
        inApp.find((n) => n.userId === where.userId && n.dedupeKey === where.dedupeKey) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `n-${inApp.length + 1}`, groupCount: 1, createdAt: new Date(), ...data };
        inApp.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = inApp.find((n) => n.id === where.id);
        if (data.groupCount?.increment) row.groupCount += data.groupCount.increment;
        return row;
      }),
    },
    userNotificationDelivery: {
      create: jest.fn(async ({ data }: any) => {
        if (deliveries.some((d) => d.userId === data.userId && d.dedupeKey === data.dedupeKey)) {
          const e: any = new Error('unique'); e.code = 'P2002'; throw e;
        }
        const row = { id: `d-${deliveries.length + 1}`, ...data };
        deliveries.push(row);
        return row;
      }),
    },
  };

  const audience = {
    resolve: jest.fn(async () => ({
      userIds: opts.recipients ?? ['u1'],
      stats: { candidates: (opts.recipients ?? ['u1']).length, eligible: 0, permitted: 0 },
    })),
  };
  const preferences = {
    effectiveFor: jest.fn(async (userId: string) =>
      opts.prefs?.[userId] ?? {
        eventKey: DL, enabled: true, deliveryMode: 'immediate', quietHoursBehavior: 'respect',
        minSeverity: null, dedupeWindowSec: null, aggregationWindowMin: null,
        routes: [{ channelType: 'in_app', channelConnectionId: null, enabled: true, deliveryMode: null }],
        isDefault: true,
      },
    ),
  };
  const realtime = { toUser: jest.fn((userId, event, payload) => emitted.push({ userId, event, payload })) };

  const svc = new PersonalNotificationDispatcher(
    prisma as any, audience as any, preferences as any, realtime as any,
  );
  return { svc, deliveries, inApp, emitted, prisma, preferences, audience };
}

const VERIFIED = { id: 'ch1', userId: 'u1', type: 'telegram', enabled: true, verifiedAt: new Date(), deletedAt: null };

describe('PersonalNotificationDispatcher', () => {
  it('creates a personal in-app record and emits to that user only', async () => {
    const { svc, inApp, emitted } = build();
    const s = await svc.dispatch({ eventKey: DL, payload: { title: 'Dune' }, eventId: 'e1' });
    expect(s.inAppCreated).toBe(1);
    expect(inApp[0]).toMatchObject({ userId: 'u1', eventKey: DL, title: 'Dune' });
    // Personal socket room, derived from JWT identity on connect.
    expect(emitted).toHaveLength(1);
    expect(emitted[0].userId).toBe('u1');
  });

  it('is IDEMPOTENT — a redelivered event does not duplicate the notification', async () => {
    const { svc, inApp } = build();
    await svc.dispatch({ eventKey: DL, payload: { title: 'Dune' }, eventId: 'e1' });
    await svc.dispatch({ eventKey: DL, payload: { title: 'Dune' }, eventId: 'e1' });
    expect(inApp).toHaveLength(1);
    expect(inApp[0].groupCount).toBe(2); // counted, not duplicated
  });

  it('routes the SAME event differently for two users', async () => {
    // The point of the engine: one event, two people, two answers.
    const { svc, inApp, deliveries } = build({
      recipients: ['u1', 'u2'],
      connections: [VERIFIED],
      prefs: {
        u1: { enabled: true, deliveryMode: 'immediate', minSeverity: null,
              routes: [{ channelType: 'telegram', channelConnectionId: 'ch1' }], isDefault: false },
        u2: { enabled: true, deliveryMode: 'immediate', minSeverity: null,
              routes: [{ channelType: 'in_app', channelConnectionId: null }], isDefault: false },
      },
    });
    const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
    expect(s.recipients).toBe(2);
    expect(deliveries.map((d) => d.userId)).toEqual(['u1']);   // telegram for u1
    expect(inApp.map((n) => n.userId)).toEqual(['u2']);        // in-app for u2
  });

  it('creates one delivery PER ROUTE, so two destinations retry independently', async () => {
    const second = { ...VERIFIED, id: 'ch2' };
    const { svc, deliveries } = build({
      connections: [VERIFIED, second],
      prefs: { u1: { enabled: true, deliveryMode: 'immediate', minSeverity: null, isDefault: false,
        routes: [
          { channelType: 'telegram', channelConnectionId: 'ch1' },
          { channelType: 'telegram', channelConnectionId: 'ch2' },
        ] } },
    });
    const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
    expect(s.deliveriesQueued).toBe(2);
    expect(deliveries.map((d) => d.channelId).sort()).toEqual(['ch1', 'ch2']);
  });

  describe('suppression is recorded with a reason', () => {
    it('preference disabled', async () => {
      const { svc } = build({ prefs: { u1: { enabled: false, routes: [], deliveryMode: 'immediate' } } });
      const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
      expect(s.suppressed).toEqual([{ userId: 'u1', reason: 'preference_disabled' }]);
    });

    it('delivery mode disabled', async () => {
      const { svc } = build({ prefs: { u1: { enabled: true, deliveryMode: 'disabled', routes: [] } } });
      const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
      expect(s.suppressed[0].reason).toBe('preference_disabled');
    });

    it('below the user minimum severity', async () => {
      const { svc } = build({ prefs: { u1: { enabled: true, deliveryMode: 'immediate', minSeverity: 'critical', routes: [] } } });
      const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' }); // 'success'
      expect(s.suppressed[0].reason).toBe('below_min_severity');
    });

    it('profile paused', async () => {
      const { svc } = build({
        profiles: { u1: { pausedUntil: new Date(Date.now() + 60_000) } },
        prefs: { u1: { enabled: true, deliveryMode: 'immediate', minSeverity: null, routes: [] } },
      });
      const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
      expect(s.suppressed[0].reason).toBe('paused');
    });

    it('a lapsed pause no longer suppresses', async () => {
      const { svc } = build({
        profiles: { u1: { pausedUntil: new Date(Date.now() - 60_000) } },
      });
      const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
      expect(s.suppressed).toHaveLength(0);
      expect(s.inAppCreated).toBe(1);
    });

    it('no routes selected', async () => {
      const { svc } = build({ prefs: { u1: { enabled: true, deliveryMode: 'immediate', minSeverity: null, routes: [] } } });
      const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
      expect(s.suppressed[0].reason).toBe('no_route');
    });
  });

  describe('connection gating', () => {
    it('does not send to a DISABLED connection', async () => {
      const { svc, deliveries } = build({
        connections: [{ ...VERIFIED, enabled: false }],
        prefs: { u1: { enabled: true, deliveryMode: 'immediate', minSeverity: null,
          routes: [{ channelType: 'telegram', channelConnectionId: 'ch1' }] } },
      });
      const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
      expect(deliveries).toHaveLength(0);
      expect(s.suppressed[0].reason).toBe('no_verified_connection');
    });

    it('does not send to a REVOKED connection', async () => {
      const { svc, deliveries } = build({
        connections: [{ ...VERIFIED, deletedAt: new Date() }],
        prefs: { u1: { enabled: true, deliveryMode: 'immediate', minSeverity: null,
          routes: [{ channelType: 'telegram', channelConnectionId: 'ch1' }] } },
      });
      await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
      expect(deliveries).toHaveLength(0);
    });

    it('records an UNVERIFIED connection as a terminal delivery, not silence', async () => {
      // The user selected this channel; they must be able to see why nothing came.
      const { svc, deliveries } = build({
        connections: [{ ...VERIFIED, verifiedAt: null }],
        prefs: { u1: { enabled: true, deliveryMode: 'immediate', minSeverity: null,
          routes: [{ channelType: 'telegram', channelConnectionId: 'ch1' }] } },
      });
      const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
      expect(s.deliveriesQueued).toBe(0);
      expect(deliveries[0]).toMatchObject({
        status: 'unverified_connection', suppressedReason: 'no_verified_connection',
      });
    });

    it("never sends to another user's connection", async () => {
      const { svc, deliveries } = build({
        connections: [{ ...VERIFIED, userId: 'someone-else' }],
        prefs: { u1: { enabled: true, deliveryMode: 'immediate', minSeverity: null,
          routes: [{ channelType: 'telegram', channelConnectionId: 'ch1' }] } },
      });
      await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
      expect(deliveries).toHaveLength(0);
    });
  });

  it('isolates one user failure from the rest', async () => {
    const { svc, preferences } = build({ recipients: ['u1', 'u2'] });
    preferences.effectiveFor.mockImplementationOnce(async () => { throw new Error('boom'); });
    const s = await svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' });
    expect(s.recipients).toBe(1); // the other user still got theirs
  });

  it('never throws at the caller — a notification failure must not break the source operation', async () => {
    const { svc, preferences } = build();
    preferences.effectiveFor.mockRejectedValue(new Error('database on fire'));
    await expect(svc.dispatch({ eventKey: DL, payload: {}, eventId: 'e1' })).resolves.toBeDefined();
  });

  describe('bus subscription — the cutover point', () => {
    it('dispatches a registered event arriving on the bus', async () => {
      // Producers already emit onto NOTIFICATION_BUS_CHANNEL; subscribing is what
      // turns the personal engine on, with no producer changes required.
      const { svc, inApp } = build();
      await svc.onDomainEvent({ event: DL, payload: { title: 'Dune' }, at: new Date().toISOString() } as never);
      expect(inApp).toHaveLength(1);
      expect(inApp[0].title).toBe('Dune');
    });

    it('ignores an event the personal catalogue does not register', async () => {
      // The legacy engine may still handle it; warning per bus event would drown
      // the log during the transition.
      const { svc, inApp } = build();
      await svc.onDomainEvent({ event: 'legacy.only.event', payload: {}, at: '' } as never);
      expect(inApp).toHaveLength(0);
    });

    it('ignores a malformed envelope', async () => {
      const { svc, inApp } = build();
      await svc.onDomainEvent({} as never);
      await svc.onDomainEvent(null as never);
      expect(inApp).toHaveLength(0);
    });

    it('uses the bus dedupeKey for idempotency', async () => {
      const { svc, inApp } = build();
      const env = { event: DL, payload: { title: 'Dune' }, dedupeKey: 'k1', at: '' };
      await svc.onDomainEvent(env as never);
      await svc.onDomainEvent(env as never);
      expect(inApp).toHaveLength(1);
      expect(inApp[0].groupCount).toBe(2);
    });

    it('drops a non-local actor id carried in the payload', async () => {
      // A media-server user id in `actorUserId` must not become a recipient; the
      // audience/eligibility layers reject it.
      const { svc, audience } = build();
      await svc.onDomainEvent({
        event: DL, payload: { actorUserId: 'plex-user-88213' }, at: '',
      } as never);
      expect(audience.resolve).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'plex-user-88213' }),
      );
      // Resolution is where it dies — the dispatcher never trusts the id itself.
    });
  });

  it('reaches nobody for an unregistered event', async () => {
    const { svc, inApp } = build();
    const s = await svc.dispatch({ eventKey: 'not.real', payload: {} });
    expect(s.recipients).toBe(0);
    expect(inApp).toHaveLength(0);
  });
});
