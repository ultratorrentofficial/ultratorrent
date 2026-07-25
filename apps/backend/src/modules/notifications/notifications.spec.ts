import { NotFoundException } from '@nestjs/common';
import { DOMAIN_EVENTS, defaultPreferenceFor, preferenceAllows } from '@ultratorrent/shared';
import { NotificationRecipientEligibilityService } from './recipient-eligibility.service';
import { NotificationRecipientResolver } from './recipient-resolver.service';
import { NotificationPreferenceService } from './notification-preference.service';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationDispatcher } from './notification-dispatcher.service';
import { allNotificationEvents, getNotificationEvent } from './notification-catalog';
import { buildFallbackPresentation } from './notification-presentation';

/* ------------------------------------------------------------- eligibility */

describe('NotificationRecipientEligibilityService', () => {
  const build = (users: Array<{ id: string; isActive: boolean }>) => {
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) => users.find((u) => u.id === where.id) ?? null),
        findMany: jest.fn(async ({ where }: any) =>
          users.filter((u) => where.id.in.includes(u.id) && u.isActive).map((u) => ({ id: u.id })),
        ),
      },
    };
    return { svc: new NotificationRecipientEligibilityService(prisma), prisma };
  };

  it('accepts an active local user', async () => {
    const { svc } = build([{ id: 'u1', isActive: true }]);
    expect(await svc.isEligible('u1')).toBe(true);
  });

  it('rejects a deactivated user', async () => {
    const { svc } = build([{ id: 'u1', isActive: false }]);
    expect(await svc.isEligible('u1')).toBe(false);
  });

  it('rejects an id that is not a local user at all', async () => {
    // A Plex/Jellyfin viewer id arriving in a payload must resolve to nothing.
    const { svc } = build([{ id: 'u1', isActive: true }]);
    expect(await svc.isEligible('plex-42')).toBe(false);
  });

  it('rejects null and empty ids without querying', async () => {
    const { svc, prisma } = build([]);
    expect(await svc.isEligible(null)).toBe(false);
    expect(await svc.isEligible(undefined)).toBe(false);
    expect(await svc.isEligible('')).toBe(false);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('looks up by PRIMARY KEY only — never by email', async () => {
    // A media-server account can legitimately share an operator's email address,
    // so resolving by email would let an external identity become a recipient.
    const { svc, prisma } = build([{ id: 'u1', isActive: true }]);
    await svc.isEligible('u1');
    const where = prisma.user.findUnique.mock.calls[0][0].where;
    expect(Object.keys(where)).toEqual(['id']);
  });

  it('filters a mixed batch in one query', async () => {
    const { svc, prisma } = build([
      { id: 'u1', isActive: true },
      { id: 'u2', isActive: false },
      { id: 'u3', isActive: true },
    ]);
    const out = await svc.filterEligible(['u1', 'u2', 'u3', 'plex-9']);
    expect(out.sort()).toEqual(['u1', 'u3']);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
  });

  it('deduplicates candidates before querying', async () => {
    const { svc, prisma } = build([{ id: 'u1', isActive: true }]);
    await svc.filterEligible(['u1', 'u1', 'u1']);
    expect(prisma.user.findMany.mock.calls[0][0].where.id.in).toEqual(['u1']);
  });
});

/* ---------------------------------------------------------------- recipients */

describe('NotificationRecipientResolver', () => {
  const build = (opts: { active?: string[]; permitted?: string[] } = {}) => {
    const active = opts.active ?? ['u1', 'u2', 'admin'];
    const prisma: any = {
      user: {
        findUnique: jest.fn(async ({ where }: any) =>
          active.includes(where.id) ? { id: where.id, isActive: true } : null,
        ),
        findMany: jest.fn(async ({ where }: any) => {
          if (where.id?.in) {
            return where.id.in.filter((id: string) => active.includes(id)).map((id: string) => ({ id }));
          }
          return (opts.permitted ?? ['admin']).map((id) => ({ id }));
        }),
      },
    };
    const eligibility = new NotificationRecipientEligibilityService(prisma);
    return { resolver: new NotificationRecipientResolver(prisma, eligibility), prisma };
  };

  const envelope = (over: Record<string, unknown> = {}) => ({
    id: 'e1',
    eventKey: DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED,
    occurredAt: new Date().toISOString(),
    payload: {},
    ...over,
  }) as never;

  it('affected_user goes to the subject, not the actor who did it', async () => {
    const { resolver } = build();
    const def = getNotificationEvent(DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED)!;
    const out = await resolver.resolve(def, envelope({ subjectUserId: 'u1', actorUserId: 'admin' }));
    expect(out).toEqual(['u1']);
  });

  it('affected_user falls back to the actor when there is no subject', async () => {
    const { resolver } = build();
    const def = getNotificationEvent(DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED)!;
    expect(await resolver.resolve(def, envelope({ actorUserId: 'u2' }))).toEqual(['u2']);
  });

  it('affected_user reaches nobody when the subject is not a local user', async () => {
    const { resolver } = build();
    const def = getNotificationEvent(DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED)!;
    expect(await resolver.resolve(def, envelope({ subjectUserId: 'plex-7' }))).toEqual([]);
  });

  it('permission_holders resolves from the permission the event declares', async () => {
    const { resolver } = build({ permitted: ['admin', 'u2'] });
    const def = getNotificationEvent(DOMAIN_EVENTS.WORKFLOW_APPROVAL_REQUESTED)!;
    const out = await resolver.resolve(def, envelope({ eventKey: def.key }));
    expect(out.sort()).toEqual(['admin', 'u2']);
  });

  it('includes SUPER_ADMIN by role, not by stored permission rows', async () => {
    const { resolver, prisma } = build();
    const def = getNotificationEvent(DOMAIN_EVENTS.WORKFLOW_APPROVAL_REQUESTED)!;
    await resolver.resolve(def, envelope({ eventKey: def.key }));
    const or = prisma.user.findMany.mock.calls[0][0].where.roles.some.role.OR;
    expect(JSON.stringify(or)).toContain('SUPER_ADMIN');
  });

  it('resource_owner prefers the owner when one is known', async () => {
    const { resolver } = build();
    const def = getNotificationEvent(DOMAIN_EVENTS.TORRENT_COMPLETED)!;
    expect(await resolver.resolve(def, envelope({ eventKey: def.key, subjectUserId: 'u1' }))).toEqual(['u1']);
  });

  it('resource_owner falls back to permission holders when ownership is unknown', async () => {
    const { resolver } = build({ permitted: ['u1', 'u2'] });
    const def = getNotificationEvent(DOMAIN_EVENTS.TORRENT_COMPLETED)!;
    const out = await resolver.resolve(def, envelope({ eventKey: def.key }));
    expect(out.sort()).toEqual(['u1', 'u2']);
  });

  it('fails closed when a permission_holders event declares no permission', async () => {
    const { resolver } = build({ permitted: ['everyone'] });
    const out = await resolver.resolve(
      { ...getNotificationEvent(DOMAIN_EVENTS.PROVIDER_OFFLINE)!, requiredPermission: undefined },
      envelope({ eventKey: DOMAIN_EVENTS.PROVIDER_OFFLINE }),
    );
    expect(out).toEqual([]);
  });
});

/* --------------------------------------------------------------- preferences */

describe('NotificationPreferenceService', () => {
  const build = (rows: any[] = []) => {
    const store = [...rows];
    const prisma: any = {
      userNotificationPreference: {
        findMany: jest.fn(async ({ where }: any) =>
          store.filter((r) => {
            const userMatches = where.userId?.in
              ? where.userId.in.includes(r.userId)
              : r.userId === where.userId;
            return userMatches && (!where.eventKey || r.eventKey === where.eventKey);
          }),
        ),
        findUnique: jest.fn(async ({ where }: any) =>
          store.find(
            (r) => r.userId === where.userId_eventKey.userId && r.eventKey === where.userId_eventKey.eventKey,
          ) ?? null,
        ),
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const existing = store.find(
            (r) => r.userId === where.userId_eventKey.userId && r.eventKey === where.userId_eventKey.eventKey,
          );
          if (existing) {
            Object.assign(existing, update);
            return existing;
          }
          const row = { ...create };
          store.push(row);
          return row;
        }),
        delete: jest.fn(async () => ({})),
      },
    };
    return { svc: new NotificationPreferenceService(prisma), store, prisma };
  };

  it('returns a full table from catalogue defaults when nothing is stored', async () => {
    const { svc } = build();
    const rows = await svc.listFor('u1');
    expect(rows).toHaveLength(allNotificationEvents().length);
    expect(rows.every((r) => !r.customized)).toBe(true);
  });

  it('never enables an external channel by default', async () => {
    for (const definition of allNotificationEvents()) {
      const pref = defaultPreferenceFor(definition);
      expect(pref.emailEnabled).toBe(false);
      expect(pref.telegramEnabled).toBe(false);
      expect(pref.discordEnabled).toBe(false);
    }
  });

  it('honours the catalogue default for in-app rather than forcing it on', async () => {
    const { svc } = build();
    const rows = await svc.listFor('u1');
    const playback = rows.find((r) => r.definition.key === DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING)!;
    const torrent = rows.find((r) => r.definition.key === DOMAIN_EVENTS.TORRENT_COMPLETED)!;
    expect(playback.preference.inAppEnabled).toBe(false); // high-volume
    expect(torrent.preference.inAppEnabled).toBe(true);
  });

  it('writes an override row on first change and marks the row customized', async () => {
    const { svc, store } = build();
    await svc.update('u1', DOMAIN_EVENTS.TORRENT_COMPLETED, { inAppEnabled: false });
    expect(store).toHaveLength(1);
    const rows = await svc.listFor('u1');
    expect(rows.find((r) => r.definition.key === DOMAIN_EVENTS.TORRENT_COMPLETED)!.customized).toBe(true);
  });

  it('seeds a new row from catalogue defaults, not from all-true', async () => {
    const { svc, store } = build();
    // Enabling email on an off-by-default event must not also switch in-app on.
    await svc.update('u1', DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING, { emailEnabled: true });
    expect(store[0]).toMatchObject({ emailEnabled: true, inAppEnabled: false });
  });

  it('rejects an uncatalogued event rather than storing a row for it', async () => {
    const { svc, store } = build();
    expect(await svc.update('u1', 'made.up', { enabled: true })).toBeNull();
    expect(store).toHaveLength(0);
  });

  it('reports what a bulk update skipped instead of silently dropping it', async () => {
    const { svc } = build();
    const result = await svc.updateMany(
      'u1',
      [DOMAIN_EVENTS.TORRENT_COMPLETED, 'made.up', DOMAIN_EVENTS.TORRENT_FAILED],
      { enabled: false },
    );
    expect(result).toEqual({ updated: 2, skipped: ['made.up'] });
  });

  it('resolves many users in one query', async () => {
    const { svc, prisma } = build([
      { userId: 'u1', eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED, enabled: true, inAppEnabled: false,
        emailEnabled: false, telegramEnabled: false, discordEnabled: false },
    ]);
    const map = await svc.effectiveForMany(['u1', 'u2'], DOMAIN_EVENTS.TORRENT_COMPLETED);
    expect(prisma.userNotificationPreference.findMany).toHaveBeenCalledTimes(1);
    expect(map.get('u1')!.inAppEnabled).toBe(false); // stored
    expect(map.get('u2')!.inAppEnabled).toBe(true); // default
  });

  it('a disabled event routes nowhere, whatever the channel flags say', () => {
    const pref = {
      eventKey: 'x', enabled: false,
      inAppEnabled: true, emailEnabled: true, telegramEnabled: true, discordEnabled: true,
    };
    for (const channel of ['in_app', 'email', 'telegram', 'discord'] as const) {
      expect(preferenceAllows(pref, channel)).toBe(false);
    }
  });
});

/* --------------------------------------------------------------------- inbox */

describe('NotificationInboxService', () => {
  const build = (rows: any[]) => {
    const store = [...rows];
    const match = (r: any, where: any): boolean => {
      if (where.userId && r.userId !== where.userId) return false;
      if (where.id && r.id !== where.id) return false;
      if (where.readAt === null && r.readAt !== null) return false;
      if (where.readAt?.not === null && r.readAt === null) return false;
      if (where.archivedAt === null && r.archivedAt !== null) return false;
      if (where.archivedAt?.not === null && r.archivedAt === null) return false;
      if (where.category && r.category !== where.category) return false;
      return true;
    };
    const prisma: any = {
      userNotification: {
        findMany: jest.fn(async ({ where }: any) => store.filter((r) => match(r, where))),
        count: jest.fn(async ({ where }: any) => store.filter((r) => match(r, where)).length),
        findFirst: jest.fn(async ({ where }: any) => store.find((r) => match(r, where)) ?? null),
        update: jest.fn(async ({ where, data }: any) => {
          const row = store.find((r) => r.id === where.id)!;
          Object.assign(row, data);
          return row;
        }),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const hit = store.filter((r) => match(r, where));
          hit.forEach((r) => Object.assign(r, data));
          return { count: hit.length };
        }),
      },
    };
    return { svc: new NotificationInboxService(prisma), store };
  };

  const row = (over: any = {}) => ({
    id: 'n1', userId: 'u1', eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
    category: 'downloads', severity: 'success', title: 'Done', body: null,
    deepLink: '/torrents', resourceType: 'torrent', resourceId: 'h1',
    readAt: null, archivedAt: null, createdAt: new Date(), ...over,
  });

  it('scopes every list to the calling user', async () => {
    const { svc } = build([row(), row({ id: 'n2', userId: 'other' })]);
    const page = await svc.list('u1', {});
    expect(page.items.map((i) => i.id)).toEqual(['n1']);
  });

  it('hides archived rows by default', async () => {
    const { svc } = build([row(), row({ id: 'n2', archivedAt: new Date() })]);
    expect((await svc.list('u1', {})).items.map((i) => i.id)).toEqual(['n1']);
  });

  it('counts only unread, unarchived rows for the badge', async () => {
    const { svc } = build([
      row(),
      row({ id: 'n2', readAt: new Date() }),
      row({ id: 'n3', archivedAt: new Date() }),
    ]);
    expect(await svc.unreadCount('u1')).toEqual({ unread: 1 });
  });

  it('refuses to touch another user’s notification, as not-found', async () => {
    const { svc } = build([row({ userId: 'other' })]);
    await expect(svc.setRead('u1', 'n1', true)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.archive('u1', 'n1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('marks read and unread', async () => {
    const { svc } = build([row()]);
    expect((await svc.setRead('u1', 'n1', true)).read).toBe(true);
    expect((await svc.setRead('u1', 'n1', false)).read).toBe(false);
  });

  it('archiving also marks read, so the badge cannot lie', async () => {
    const { svc } = build([row()]);
    const out = await svc.archive('u1', 'n1');
    expect(out.archived).toBe(true);
    expect(out.read).toBe(true);
  });

  it('mark-all-read leaves other users alone', async () => {
    const { svc, store } = build([row(), row({ id: 'n2', userId: 'other' })]);
    expect(await svc.markAllRead('u1')).toEqual({ updated: 1 });
    expect(store.find((r) => r.id === 'n2')!.readAt).toBeNull();
  });

  it('clamps an absurd page size', async () => {
    const { svc } = build([row()]);
    expect((await svc.list('u1', { pageSize: '5000' })).pageSize).toBe(100);
  });
});

/* ---------------------------------------------------------------- dispatcher */

describe('NotificationDispatcher', () => {
  const build = (opts: { audience?: string[]; prefs?: Record<string, any>; failOn?: string; canViewPlayback?: boolean } = {}) => {
    const created: any[] = [];
    const toUser = jest.fn();
    const prisma: any = {
      // The dispatcher resolves playback-detail permission per recipient before
      // building the rich card, so the mock must answer that too.
      user: { findFirst: jest.fn(async () => (opts.canViewPlayback === false ? null : { id: 'u' })) },
      userNotification: {
        create: jest.fn(async ({ data }: any) => {
          if (opts.failOn === data.userId) {
            throw Object.assign(new Error('nope'), { code: 'P2002' });
          }
          const row = { ...data, id: data.id ?? `n${created.length + 1}`, createdAt: new Date() };
          created.push(row);
          return row;
        }),
      },
    };
    const recipients: any = { resolve: jest.fn(async () => opts.audience ?? ['u1']) };
    const preferences: any = {
      effectiveForMany: jest.fn(async (ids: string[], key: string) => {
        const map = new Map();
        for (const id of ids) {
          map.set(id, opts.prefs?.[id] ?? defaultPreferenceFor(getNotificationEvent(key)!));
        }
        return map;
      }),
    };
    const bus: any = { subscribe: jest.fn(() => () => undefined) };
    const realtime: any = { toUser };
    return {
      svc: new NotificationDispatcher(prisma, bus, recipients, preferences, realtime),
      created, toUser, recipients,
    };
  };

  const envelope = (over: any = {}) => ({
    id: 'evt-1',
    eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
    occurredAt: new Date().toISOString(),
    resourceType: 'torrent',
    resourceId: 'h1',
    payload: { torrentName: 'Dune.2021', hash: 'h1' },
    ...over,
  });

  it('creates one owned notification per opted-in recipient', async () => {
    const { svc, created } = build({ audience: ['u1', 'u2'] });
    const summary = await svc.dispatch(envelope() as never);
    expect(summary).toMatchObject({ audience: 2, created: 2 });
    expect(created.map((c) => c.userId).sort()).toEqual(['u1', 'u2']);
    expect(created.every((c) => c.userId)).toBe(true);
  });

  it('ignores a domain event that is not catalogued as a notification', async () => {
    // Automation and workflow waits read the same bus, so most domain events are
    // not notifications. Such an event must cost nothing — not even a resolve.
    const { svc, created, recipients } = build();
    const summary = await svc.dispatch(envelope({ eventKey: 'totally.unknown' }) as never);
    expect(summary).toMatchObject({ audience: 0, created: 0 });
    expect(recipients.resolve).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
  });

  it('skips a recipient whose preference has in-app off', async () => {
    const { svc, created } = build({
      audience: ['u1', 'u2'],
      prefs: {
        u2: { eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED, enabled: true, inAppEnabled: false,
              emailEnabled: false, telegramEnabled: false, discordEnabled: false },
      },
    });
    const summary = await svc.dispatch(envelope() as never);
    expect(summary).toMatchObject({ created: 1, skipped: 1 });
    expect(created.map((c) => c.userId)).toEqual(['u1']);
  });

  it('skips a recipient who disabled the event entirely', async () => {
    const { svc, created } = build({
      audience: ['u1'],
      prefs: {
        u1: { eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED, enabled: false, inAppEnabled: true,
              emailEnabled: false, telegramEnabled: false, discordEnabled: false },
      },
    });
    expect(await svc.dispatch(envelope() as never)).toMatchObject({ created: 0, skipped: 1 });
    expect(created).toHaveLength(0);
  });

  it('treats a redelivered event as already handled, not as an error', async () => {
    const { svc } = build({ audience: ['u1'], failOn: 'u1' });
    const summary = await svc.dispatch(envelope() as never);
    expect(summary).toMatchObject({ created: 0, skipped: 1 });
  });

  it('one failing recipient does not stop the others', async () => {
    const { svc, created } = build({ audience: ['u1', 'u2', 'u3'], failOn: 'u2' });
    const summary = await svc.dispatch(envelope() as never);
    expect(summary.created).toBe(2);
    expect(created.map((c) => c.userId)).toEqual(['u1', 'u3']);
  });

  it('emits to the recipient’s own socket room only', async () => {
    const { svc, toUser } = build({ audience: ['u1'] });
    await svc.dispatch(envelope() as never);
    expect(toUser).toHaveBeenCalledWith('u1', 'account.notification.created', expect.anything());
  });

  it('never throws, whatever the resolver does', async () => {
    const { svc } = build();
    (svc as any).recipients = { resolve: jest.fn(async () => { throw new Error('db down'); }) };
    await expect(svc.dispatch(envelope() as never)).resolves.toMatchObject({ created: 0 });
  });
});

/* -------------------------------------------------------------- presentation */

describe('buildFallbackPresentation', () => {
  const env = (payload: Record<string, unknown>) => ({
    id: 'e', eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
    occurredAt: new Date().toISOString(), payload,
  }) as never;

  it('names the subject when the payload has one', () => {
    const out = buildFallbackPresentation(getNotificationEvent(DOMAIN_EVENTS.TORRENT_COMPLETED)!, env({ torrentName: 'Dune.2021' }));
    expect(out.title).toBe('Completed: Dune.2021');
  });

  it('degrades to the humanized event rather than a raw key', () => {
    const out = buildFallbackPresentation(getNotificationEvent(DOMAIN_EVENTS.TORRENT_COMPLETED)!, env({}));
    expect(out.title).toBe('Completed');
    expect(out.title).not.toContain('torrent.');
  });

  it('builds the deep link from a fixed map, never from the payload', () => {
    const out = buildFallbackPresentation(
      getNotificationEvent(DOMAIN_EVENTS.TORRENT_COMPLETED)!,
      env({ torrentName: 'x', deepLink: 'https://evil.example' }),
    );
    expect(out.deepLink).toBe('/torrents');
  });

  it('renders no secret-ish field even when the payload carries one', () => {
    const out = buildFallbackPresentation(
      getNotificationEvent(DOMAIN_EVENTS.SECURITY_API_KEY_CREATED)!,
      env({ token: 'sk-live-123', webhookUrl: 'https://x', ipAddress: '10.0.0.1' }),
    );
    expect(JSON.stringify(out)).not.toContain('sk-live-123');
    expect(JSON.stringify(out)).not.toContain('10.0.0.1');
  });

  it('caps a hostile title length', () => {
    const out = buildFallbackPresentation(
      getNotificationEvent(DOMAIN_EVENTS.TORRENT_COMPLETED)!,
      env({ torrentName: 'A'.repeat(5000) }),
    );
    expect(out.title.length).toBeLessThanOrEqual(300);
  });
});

/* ------------------------------------------------------------------ catalogue */

describe('notification catalogue', () => {
  it('registers only events a real producer publishes', () => {
    const domain = new Set<string>(Object.values(DOMAIN_EVENTS));
    for (const definition of allNotificationEvents()) {
      expect(domain.has(definition.key)).toBe(true);
    }
  });

  it('gives every permission_holders event a permission to resolve from', () => {
    for (const definition of allNotificationEvents()) {
      if (definition.recipientStrategy === 'permission_holders') {
        expect(definition.requiredPermission).toBeTruthy();
      }
    }
  });

  it('keeps personal security events on affected_user', () => {
    for (const key of [
      DOMAIN_EVENTS.SECURITY_PASSWORD_CHANGED,
      DOMAIN_EVENTS.SECURITY_TWO_FACTOR_DISABLED,
      DOMAIN_EVENTS.SECURITY_API_KEY_CREATED,
      DOMAIN_EVENTS.SECURITY_LOGIN_FAILED,
    ]) {
      expect(getNotificationEvent(key)!.recipientStrategy).toBe('affected_user');
    }
  });

  it('declares a unique key per event', () => {
    const keys = allNotificationEvents().map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
