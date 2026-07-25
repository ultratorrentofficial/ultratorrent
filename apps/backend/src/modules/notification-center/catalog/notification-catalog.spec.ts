import { NOTIFICATION_EVENTS, PERMISSIONS, NOTIFICATION_CHANNEL_TYPES } from '@ultratorrent/shared';
import {
  NOTIFICATION_CATALOG,
  activeEventDefinitions,
  getEventDefinition,
  validateEventPayload,
} from './notification-catalog';
import { NotificationAudienceResolver } from './audience-resolver.service';
import { NotificationRecipientEligibilityService } from '../recipient-eligibility.service';

const ALL_EVENT_KEYS = Object.values(NOTIFICATION_EVENTS).filter(
  (v) => typeof v === 'string',
) as string[];
const PERMISSION_VALUES = new Set(Object.values(PERMISSIONS) as string[]);

describe('notification catalog integrity', () => {
  it('registers every event key exactly once', () => {
    const keys = NOTIFICATION_CATALOG.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers every personal-notification event across 10 namespaces', () => {
    // 69 pre-existing events plus `automation.rule_failed`, added during the
    // producer cutover because the automation engine had no registered event to
    // emit and was still calling the legacy free-text dispatcher.
    expect(NOTIFICATION_CATALOG).toHaveLength(70);
    const namespaces = new Set(NOTIFICATION_CATALOG.map((d) => d.key.split('.')[0]));
    expect(namespaces.size).toBe(10);
  });

  it('only registers keys that exist in NOTIFICATION_EVENTS', () => {
    // Guards against a hand-typed key drifting from the shared contract — the
    // catalogue would then describe an event nothing can ever emit.
    for (const d of NOTIFICATION_CATALOG) expect(ALL_EVENT_KEYS).toContain(d.key);
  });

  it('references only real permissions', () => {
    for (const d of NOTIFICATION_CATALOG) {
      if (d.requiredPermission) expect(PERMISSION_VALUES.has(d.requiredPermission)).toBe(true);
    }
  });

  it('never defaults an external channel on', () => {
    // An external channel needs a connection the user has not created yet, so
    // defaulting it on would promise delivery that silently never happens.
    for (const d of NOTIFICATION_CATALOG) {
      for (const ch of d.defaultPreferences.channels) expect(ch).toBe('in_app');
    }
  });

  it('offers only known channel types', () => {
    for (const d of NOTIFICATION_CATALOG) {
      for (const ch of d.supportedChannels) {
        expect(NOTIFICATION_CHANNEL_TYPES as readonly string[]).toContain(ch);
      }
    }
  });

  it('keeps security-sensitive events out of quiet hours and aggregation', () => {
    // You learn about a credential event when it happens, and it is never merged
    // into "3 similar events".
    const security = NOTIFICATION_CATALOG.filter((d) => d.sensitivity === 'security');
    expect(security.length).toBeGreaterThan(0);
    for (const d of security) {
      expect(d.defaultPreferences.quietHoursBehavior).toBe('bypass');
      if (d.key !== NOTIFICATION_EVENTS.SYSTEM_FAILED_LOGIN) {
        expect(d.aggregation?.supported ?? false).toBe(false);
      }
    }
  });

  it('addresses account events to the person they are about, not to admins', () => {
    for (const key of [NOTIFICATION_EVENTS.SYSTEM_NEW_LOGIN, NOTIFICATION_EVENTS.SYSTEM_API_KEY_CREATED]) {
      expect(getEventDefinition(key)?.audience).toBe('subject_user');
    }
  });

  it('gives every permission_holders/approvers event a permission to derive from', () => {
    // That audience IS the permission holder set; without one it would resolve to
    // nobody, which is safe but silently broken.
    for (const d of NOTIFICATION_CATALOG) {
      if (d.audience === 'permission_holders' || d.audience === 'approvers') {
        expect(d.requiredPermission).toBeDefined();
      }
    }
  });

  it('marks the three producer-less media_server events deprecated', () => {
    // Seeded rules exist for these but nothing emits them; the matrix must not
    // offer a toggle that can never do anything.
    for (const key of [
      NOTIFICATION_EVENTS.MEDIA_SERVER_USER_PAUSED,
      NOTIFICATION_EVENTS.MEDIA_SERVER_USER_RESUMED,
      NOTIFICATION_EVENTS.MEDIA_SERVER_USER_STOPPED,
    ]) {
      expect(getEventDefinition(key)?.deprecated).toBeDefined();
    }
    expect(activeEventDefinitions().length).toBeLessThan(NOTIFICATION_CATALOG.length);
  });

  it('still resolves a deprecated event, so a stored preference does not break', () => {
    expect(getEventDefinition(NOTIFICATION_EVENTS.MEDIA_DUPLICATE)).toBeDefined();
  });
});

describe('validateEventPayload', () => {
  it('rejects an unregistered event', () => {
    expect(validateEventPayload('not.a.real.event', {})).toMatchObject({ valid: false, reason: 'unregistered_event' });
  });

  it('reports missing required fields', () => {
    const r = validateEventPayload(NOTIFICATION_EVENTS.SYSTEM_SECURITY_ALERT, {});
    expect(r).toMatchObject({ valid: false, reason: 'missing_payload_fields' });
    expect(r.missing).toContain('message');
  });

  it('treats null and empty string as missing', () => {
    expect(validateEventPayload(NOTIFICATION_EVENTS.SYSTEM_SECURITY_ALERT, { message: '' }).valid).toBe(false);
    expect(validateEventPayload(NOTIFICATION_EVENTS.SYSTEM_SECURITY_ALERT, { message: null }).valid).toBe(false);
  });

  it('accepts a complete payload', () => {
    expect(validateEventPayload(NOTIFICATION_EVENTS.SYSTEM_SECURITY_ALERT, { message: 'breach' }).valid).toBe(true);
  });

  it('accepts a missing payload for an event that requires no fields', () => {
    expect(validateEventPayload(NOTIFICATION_EVENTS.SYSTEM_BACKUP_FAILED, undefined).valid).toBe(true);
  });
});

/** Users the stub knows about, with roles + permissions. */
interface StubUser {
  id: string;
  isActive: boolean;
  role?: string;
  permissions?: string[];
}

function build(users: StubUser[]) {
  const match = (u: StubUser, where: any): boolean => {
    if (where.isActive !== undefined && u.isActive !== where.isActive) return false;
    if (where.id?.in && !where.id.in.includes(u.id)) return false;
    if (where.roles?.some) {
      const r = where.roles.some.role;
      const names: string[] = r.name?.in ?? (typeof r.name === 'string' ? [r.name] : []);
      const or: any[] = r.OR ?? [];
      if (or.length) {
        const superOk = or.some((o) => o.name && u.role === o.name);
        const permKey = or.find((o) => o.permissions)?.permissions?.some?.permission?.key;
        const permOk = permKey ? (u.permissions ?? []).includes(permKey) : false;
        if (!superOk && !permOk) return false;
      } else if (names.length && !names.includes(u.role ?? '')) return false;
    }
    return true;
  };
  const prisma = {
    user: {
      findMany: jest.fn(async ({ where }: any) => users.filter((u) => match(u, where)).map((u) => ({ id: u.id }))),
      findUnique: jest.fn(async ({ where }: any) => users.find((u) => u.id === where.id) ?? null),
    },
  };
  const eligibility = new NotificationRecipientEligibilityService(prisma as any);
  return { svc: new NotificationAudienceResolver(prisma as any, eligibility), prisma };
}

const ADMIN: StubUser = { id: 'admin-1', isActive: true, role: 'SUPER_ADMIN', permissions: [] };
const VIEWER: StubUser = { id: 'user-1', isActive: true, role: 'USER', permissions: [PERMISSIONS.TORRENTS_VIEW] };
const NOPERM: StubUser = { id: 'user-2', isActive: true, role: 'USER', permissions: [] };
const DISABLED: StubUser = { id: 'user-off', isActive: false, role: 'USER', permissions: [PERMISSIONS.TORRENTS_VIEW] };

describe('NotificationAudienceResolver', () => {
  const dl = NOTIFICATION_EVENTS.DOWNLOAD_TORRENT_COMPLETED;

  it('reaches nobody for an unregistered event', async () => {
    const { svc } = build([ADMIN]);
    expect(await svc.resolve({ eventKey: 'nope.nope', payload: {} })).toMatchObject({
      userIds: [], reason: 'unregistered_event',
    });
  });

  it('reaches nobody when the payload is incomplete', async () => {
    const { svc } = build([ADMIN]);
    const r = await svc.resolve({ eventKey: NOTIFICATION_EVENTS.SYSTEM_SECURITY_ALERT, payload: {} });
    expect(r).toMatchObject({ userIds: [], reason: 'invalid_payload' });
  });

  it('resolves permission_holders to users holding the declared permission', async () => {
    const { svc } = build([VIEWER, NOPERM]);
    const r = await svc.resolve({ eventKey: dl, payload: {} });
    expect(r.userIds).toEqual(['user-1']);
  });

  it('excludes a user lacking the permission, even inside the audience', async () => {
    const { svc } = build([NOPERM]);
    const r = await svc.resolve({ eventKey: dl, payload: {} });
    expect(r.userIds).toEqual([]);
    expect(r.reason).toBe('empty_audience');
  });

  it('includes SUPER_ADMIN, who holds every permission implicitly', async () => {
    const { svc } = build([ADMIN]);
    expect((await svc.resolve({ eventKey: dl, payload: {} })).userIds).toEqual(['admin-1']);
  });

  it('excludes a deactivated user', async () => {
    const { svc } = build([DISABLED]);
    expect((await svc.resolve({ eventKey: dl, payload: {} })).userIds).toEqual([]);
  });

  it('addresses subject_user events to that person only', async () => {
    const { svc } = build([ADMIN, VIEWER]);
    const r = await svc.resolve({
      eventKey: NOTIFICATION_EVENTS.SYSTEM_NEW_LOGIN, payload: {}, subjectUserId: 'user-1',
    });
    expect(r.userIds).toEqual(['user-1']);
  });

  it('never resolves an EXTERNAL identity, even when handed one directly', async () => {
    // The heart of it: a media-server user id in the subject field must not
    // become a recipient. It is not in `users`, so eligibility drops it.
    const { svc } = build([ADMIN, VIEWER]);
    const r = await svc.resolve({
      eventKey: NOTIFICATION_EVENTS.SYSTEM_NEW_LOGIN, payload: {}, subjectUserId: 'plex-user-88213',
    });
    expect(r.userIds).toEqual([]);
    expect(r.reason).toBe('no_eligible');
  });

  it('validates explicit recipients rather than trusting them', async () => {
    const { svc } = build([VIEWER]);
    const r = await svc.resolve({
      eventKey: NOTIFICATION_EVENTS.SYSTEM_NEW_LOGIN,
      payload: {},
      subjectUserId: 'user-1',
      explicitRecipientUserIds: ['plex-user-88213', 'user-does-not-exist'],
    });
    // subject_user audience ignores the explicit list; either way nothing forged
    // reaches the output.
    expect(r.userIds).not.toContain('plex-user-88213');
  });

  it('resolves resource_owner to owner AND actor, deduplicated', async () => {
    const { svc } = build([
      { id: 'owner', isActive: true, role: 'USER', permissions: [PERMISSIONS.WORKFLOWS_VIEW] },
      { id: 'runner', isActive: true, role: 'USER', permissions: [PERMISSIONS.WORKFLOWS_VIEW] },
    ]);
    const r = await svc.resolve({
      eventKey: NOTIFICATION_EVENTS.WORKFLOW_EXECUTION_FAILED,
      payload: {}, resourceOwnerUserId: 'owner', actorUserId: 'runner',
    });
    expect(r.userIds.sort()).toEqual(['owner', 'runner']);

    const same = await svc.resolve({
      eventKey: NOTIFICATION_EVENTS.WORKFLOW_EXECUTION_FAILED,
      payload: {}, resourceOwnerUserId: 'owner', actorUserId: 'owner',
    });
    expect(same.userIds).toEqual(['owner']); // notified once, not twice
  });

  it('reports where candidates were dropped', async () => {
    const { svc } = build([VIEWER, NOPERM]);
    const r = await svc.resolve({ eventKey: dl, payload: {} });
    expect(r.stats.eligible).toBeGreaterThanOrEqual(r.stats.permitted);
  });

  it('checks eligibility BEFORE permissions', async () => {
    // An id from another namespace must never reach the permission tables.
    const { svc, prisma } = build([VIEWER]);
    await svc.resolve({
      eventKey: NOTIFICATION_EVENTS.SYSTEM_NEW_LOGIN, payload: {}, subjectUserId: 'plex-user-1',
    });
    const permissionQueries = prisma.user.findMany.mock.calls.filter((c: any) => c[0]?.where?.roles);
    expect(permissionQueries).toHaveLength(0);
  });
});
