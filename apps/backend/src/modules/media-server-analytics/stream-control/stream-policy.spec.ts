import { StreamPolicyService } from './stream-policy.service';
import { StreamControlSettingsService, StreamControlSettings } from './stream-control-settings.service';

const SETTINGS: StreamControlSettings = {
  enabled: true, defaultLimit: 2, defaultAction: 'terminate_newest',
  gracePeriodSeconds: 10, countPaused: true, pausedExpirationMinutes: 5, scope: 'all_servers',
};

const user = (over: Partial<{ exemptFromLimits: boolean }> = {}) => ({
  id: 'u1', kind: 'plex', providerUserId: '100', displayName: 'John',
  exemptFromLimits: false, createdAt: new Date(), updatedAt: new Date(), ...over,
}) as never;

const pol = (over: Record<string, unknown>) => ({
  id: 'p1', mediaAnalyticsUserId: 'u1', mediaServerId: null, maxConcurrentStreams: null,
  enforcementAction: null, gracePeriodSeconds: null, countPaused: null, scope: null,
  enabled: true, createdAt: new Date(), updatedAt: new Date(), ...over,
}) as never;

describe('StreamPolicyService.effectivePolicy (spec §9 priority)', () => {
  const svc = new StreamPolicyService({} as never, {} as never);

  it('falls back to the global default when there is no override', () => {
    const eff = svc.effectivePolicy(user(), null, null, null, SETTINGS);
    expect(eff).toMatchObject({ limit: 2, source: 'global', exempt: false, action: 'terminate_newest' });
  });

  it('a per-user custom limit wins over the global default', () => {
    const eff = svc.effectivePolicy(user(), pol({ maxConcurrentStreams: 1 }), null, null, SETTINGS);
    expect(eff).toMatchObject({ limit: 1, source: 'user' });
  });

  it('a per-user unlimited override means no limit', () => {
    const eff = svc.effectivePolicy(user(), pol({ maxConcurrentStreams: null }), null, null, SETTINGS);
    expect(eff.limit).toBeNull();
    expect(eff.source).toBe('user');
  });

  it('a disabled override is ignored (back to global)', () => {
    const eff = svc.effectivePolicy(user(), pol({ maxConcurrentStreams: 1, enabled: false }), null, null, SETTINGS);
    expect(eff).toMatchObject({ limit: 2, source: 'global' });
  });

  it('an exempt subject is never limited', () => {
    const eff = svc.effectivePolicy(user({ exemptFromLimits: true }), pol({ maxConcurrentStreams: 1 }), null, null, SETTINGS);
    expect(eff).toMatchObject({ limit: null, source: 'exempt', exempt: true });
  });

  it('a per-server default applies when the user has no override', () => {
    const serverDefault = pol({ id: 'sd', mediaAnalyticsUserId: null, mediaServerId: 'srv1', maxConcurrentStreams: 3 });
    const eff = svc.effectivePolicy(user(), null, serverDefault, 'srv1', SETTINGS);
    expect(eff).toMatchObject({ limit: 3, source: 'server' });
  });

  it('a per-user override wins over a per-server default', () => {
    const serverDefault = pol({ id: 'sd', mediaAnalyticsUserId: null, mediaServerId: 'srv1', maxConcurrentStreams: 3 });
    const eff = svc.effectivePolicy(user(), pol({ maxConcurrentStreams: 1 }), serverDefault, 'srv1', SETTINGS);
    expect(eff).toMatchObject({ limit: 1, source: 'user' });
  });

  it('an override inherits unset fields (action/grace) from the global default', () => {
    const eff = svc.effectivePolicy(user(), pol({ maxConcurrentStreams: 1, enforcementAction: null, gracePeriodSeconds: null }), null, null, SETTINGS);
    expect(eff.action).toBe('terminate_newest');
    expect(eff.gracePeriodSeconds).toBe(10);
  });
});

describe('StreamPolicyService.combineEffective (linked group — most restrictive wins)', () => {
  const svc = new StreamPolicyService({} as never, {} as never);
  const eff = (over: Record<string, unknown>) => ({
    limit: null, action: 'terminate_newest', gracePeriodSeconds: 10, countPaused: true,
    pausedExpirationMinutes: 5, scope: 'all_servers', source: 'global', exempt: false, ...over,
  }) as never;

  it('picks the tightest numeric limit across members', () => {
    expect(svc.combineEffective([eff({ limit: 3, source: 'user' }), eff({ limit: 1, source: 'user' })]).limit).toBe(1);
  });
  it('stays unlimited when every member is unlimited', () => {
    expect(svc.combineEffective([eff({ limit: null }), eff({ limit: null })]).limit).toBeNull();
  });
  it('exempts the whole person if any linked account is exempt', () => {
    const r = svc.combineEffective([eff({ limit: 1 }), eff({ exempt: true, limit: null })]);
    expect(r.exempt).toBe(true);
    expect(r.limit).toBeNull();
  });
});

describe('StreamPolicyService link/unlink', () => {
  function fake() {
    const rows = [
      { id: 'p', kind: 'plex', providerUserId: '1', groupId: null as string | null },
      { id: 'j', kind: 'jellyfin', providerUserId: 'X', groupId: null as string | null },
      { id: 'e', kind: 'emby', providerUserId: 'Y', groupId: null as string | null },
    ];
    const prisma = {
      mediaAnalyticsUser: {
        findMany: async ({ where }: any) => rows.filter((r) => (where.id?.in ? where.id.in.includes(r.id) : true) && (where.groupId ? r.groupId === where.groupId : true) && (where.OR ? where.OR.some((c: any) => (c.id?.in && c.id.in.includes(r.id)) || (c.groupId?.in && c.groupId.in.includes(r.groupId))) : true)),
        findUnique: async ({ where }: any) => rows.find((r) => r.id === where.id) ?? null,
        update: async ({ where, data }: any) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return r; },
        updateMany: async ({ where, data }: any) => {
          for (const r of rows) {
            const match = (where.OR ? where.OR.some((c: any) => (c.id?.in && c.id.in.includes(r.id)) || (c.groupId?.in && r.groupId && c.groupId.in.includes(r.groupId))) : true) && (where.groupId ? r.groupId === where.groupId : true);
            if (match) Object.assign(r, data);
          }
          return { count: 0 };
        },
      },
    };
    return { rows, svc: new StreamPolicyService(prisma as never, {} as never) };
  }

  it('links two subjects under one new group id', async () => {
    const { rows, svc } = fake();
    const g = await svc.linkSubjects(['p', 'j']);
    expect(g).toBeTruthy();
    expect(rows.find((r) => r.id === 'p')!.groupId).toBe(g);
    expect(rows.find((r) => r.id === 'j')!.groupId).toBe(g);
  });

  it('unlinking down to a single member dissolves the group', async () => {
    const { rows, svc } = fake();
    const g = await svc.linkSubjects(['p', 'j']);
    void g;
    await svc.unlinkSubject('p');
    expect(rows.find((r) => r.id === 'p')!.groupId).toBeNull();
    // 'j' would be alone → group dissolved.
    expect(rows.find((r) => r.id === 'j')!.groupId).toBeNull();
  });

  it('does nothing for a single id', async () => {
    const { svc } = fake();
    expect(await svc.linkSubjects(['p'])).toBeNull();
  });
});

describe('StreamPolicyService.candidates', () => {
  it('lists known viewers not yet configured — never creates anything', async () => {
    const prisma = {
      mediaServerUser: {
        findMany: async () => [
          { connectionId: 'plex1', providerUserId: '100', userName: 'john', displayName: 'John' },
          { connectionId: 'jf1', providerUserId: 'JF', userName: 'mary', displayName: null },
          { connectionId: 'plex1', providerUserId: '200', userName: 'alex', displayName: 'Alex' }, // already configured → excluded
          { connectionId: 'gone', providerUserId: '999', userName: 'ghost', displayName: null }, // connection removed → excluded
        ],
      },
      mediaServerIntegration: { findMany: async () => [{ id: 'plex1', kind: 'plex' }, { id: 'jf1', kind: 'jellyfin' }] },
      // The "configured" set (has a policy / exemption / link).
      mediaAnalyticsUser: { findMany: async () => [{ kind: 'plex', providerUserId: '200' }] },
    };
    const svc = new StreamPolicyService(prisma as never, {} as never);
    const c = await svc.candidates();
    expect(c.map((x) => `${x.kind}:${x.providerUserId}`).sort()).toEqual(['jellyfin:JF', 'plex:100']);
  });
});

describe('StreamControlSettingsService.read defaults & clamping', () => {
  const build = (stored: Record<string, unknown> | undefined) =>
    new StreamControlSettingsService({ get: async () => stored, set: async () => undefined } as never);

  it('returns safe defaults when nothing is stored (enforcement OFF, unlimited)', async () => {
    const s = await build(undefined).read();
    expect(s).toEqual(SETTINGS.enabled ? { ...SETTINGS, enabled: false, defaultLimit: null } : s);
    expect(s.enabled).toBe(false);
    expect(s.defaultLimit).toBeNull();
    expect(s.defaultAction).toBe('terminate_newest');
  });

  it('clamps the grace period to 0..300 and the limit to 1..100', async () => {
    const s = await build({ gracePeriodSeconds: 9999, defaultLimit: 500 }).read();
    expect(s.gracePeriodSeconds).toBe(300);
    expect(s.defaultLimit).toBe(100);
  });

  it('rejects an unknown action/scope and keeps the default', async () => {
    const s = await build({ defaultAction: 'nuke', scope: 'galaxy' }).read();
    expect(s.defaultAction).toBe('terminate_newest');
    expect(s.scope).toBe('all_servers');
  });
});
