import { StreamEnforcementService } from './stream-enforcement.service';
import { StreamPolicyService } from './stream-policy.service';
import { StreamControlSettings } from './stream-control-settings.service';

/** Minimal in-memory Prisma covering exactly what the engine + policy service touch. */
function fakePrisma(opts: {
  sessions: any[];
  connections: any[];
  subjects?: any[];
  policies?: any[];
}) {
  const subjects = opts.subjects ? [...opts.subjects] : [];
  const policies = opts.policies ? [...opts.policies] : [];
  const events: any[] = [];
  let seq = 0;
  return {
    events,
    subjects,
    prisma: {
      mediaServerSession: { findMany: async () => opts.sessions },
      mediaServerIntegration: { findMany: async () => opts.connections },
      mediaAnalyticsUser: {
        findUnique: async ({ where }: any) => {
          if (where.kind_providerUserId) {
            const { kind, providerUserId } = where.kind_providerUserId;
            return subjects.find((s) => s.kind === kind && s.providerUserId === providerUserId) ?? null;
          }
          return subjects.find((s) => s.id === where.id) ?? null;
        },
        create: async ({ data }: any) => {
          const row = { id: `subj${++seq}`, displayName: null, exemptFromLimits: false, createdAt: new Date(), updatedAt: new Date(), ...data };
          subjects.push(row);
          return row;
        },
        update: async ({ where, data }: any) => {
          const row = subjects.find((s) => s.id === where.id)!;
          Object.assign(row, data);
          return row;
        },
      },
      mediaStreamPolicy: {
        findMany: async ({ where }: any) => {
          if (where?.mediaAnalyticsUserId?.in) return policies.filter((p) => where.mediaAnalyticsUserId.in.includes(p.mediaAnalyticsUserId));
          if (where?.mediaAnalyticsUserId === null) return policies.filter((p) => p.mediaAnalyticsUserId === null && p.mediaServerId != null);
          return policies;
        },
        findUnique: async ({ where }: any) => policies.find((p) => p.mediaAnalyticsUserId === where.mediaAnalyticsUserId) ?? null,
      },
      mediaStreamEnforcementEvent: { create: async ({ data }: any) => { events.push(data); return data; } },
    },
  };
}

const SETTINGS = (over: Partial<StreamControlSettings> = {}): StreamControlSettings => ({
  enabled: true, defaultLimit: 2, defaultAction: 'terminate_newest',
  gracePeriodSeconds: 0, countPaused: true, pausedExpirationMinutes: 5, scope: 'all_servers', ...over,
});

const session = (over: any) => ({
  id: over.id, connectionId: over.connectionId ?? 'plex1', providerSessionId: over.providerSessionId ?? over.id,
  providerUserId: over.providerUserId ?? '100', userName: over.userName ?? 'John', title: over.title ?? 'Movie',
  device: 'Roku', client: 'Plex', ipAddress: '1.2.3.4', playbackState: over.playbackState ?? 'playing',
  startedAt: over.startedAt ?? new Date(), updatedAt: over.updatedAt ?? new Date(),
});

const PLEX_ONLINE = [{ id: 'plex1', kind: 'plex', status: 'online', capabilities: { terminateSessions: true } }];

function build(opts: { settings: StreamControlSettings; sessions: any[]; connections?: any[]; policies?: any[]; subjects?: any[]; terminate?: any }) {
  const fp = fakePrisma({ sessions: opts.sessions, connections: opts.connections ?? PLEX_ONLINE, policies: opts.policies, subjects: opts.subjects });
  const settingsSvc = { read: async () => opts.settings } as never;
  const policy = new StreamPolicyService(fp.prisma as never, settingsSvc);
  const terminate = opts.terminate ?? jest.fn(async () => ({ supported: true, result: { success: true, sessionId: 'x', provider: 'plex' } }));
  const integrations = { terminateSession: terminate } as never;
  const broadcast = jest.fn();
  const realtime = { broadcast } as never;
  const registry = { getStatus: () => ({ enabled: true }) } as never;
  const lock = { withLock: async (_k: string, _t: number, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() }), usesRedis: () => false } as never;
  const svc = new StreamEnforcementService(fp.prisma as never, policy, integrations, realtime, registry, lock);
  return { svc, events: fp.events, terminate, broadcast };
}

/**
 * Enforcement now waits at least one poll cycle before acting (so a just-paused or
 * just-moved stream settles in a fresh snapshot first). Simulate that: run a pass to
 * arm the grace, advance the clock past the floor, run again.
 */
async function enforceAndAct(svc: StreamEnforcementService): Promise<void> {
  const base = Date.now();
  const spy = jest.spyOn(Date, 'now').mockReturnValue(base);
  try {
    await svc.enforce();
    spy.mockReturnValue(base + 30_000);
    await svc.enforce();
  } finally {
    spy.mockRestore();
  }
}

describe('StreamEnforcementService.enforce', () => {
  it('does nothing while enforcement is disabled', async () => {
    const { svc, terminate, events } = build({ settings: SETTINGS({ enabled: false }), sessions: [session({ id: 'a' }), session({ id: 'b' })] });
    await svc.enforce();
    expect(terminate).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('stops the NEWEST stream when a limit-1 account runs two', async () => {
    const { svc, terminate, events } = build({
      settings: SETTINGS({ defaultLimit: 1 }),
      sessions: [
        session({ id: 'old', providerSessionId: 'sOld', startedAt: new Date('2026-01-01T18:00:00Z') }),
        session({ id: 'new', providerSessionId: 'sNew', startedAt: new Date('2026-01-01T18:30:00Z') }),
      ],
    });
    await enforceAndAct(svc);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith('plex1', 'sNew', expect.objectContaining({ message: expect.stringContaining('maximum of 1') }));
    expect(events[0]).toMatchObject({ action: 'terminate_newest', result: 'success', configuredLimit: 1, observedStreams: 2 });
  });

  it('stops the OLDEST stream under terminate_oldest', async () => {
    const { svc, terminate } = build({
      settings: SETTINGS({ defaultLimit: 1, defaultAction: 'terminate_oldest' }),
      sessions: [
        session({ id: 'old', providerSessionId: 'sOld', startedAt: new Date('2026-01-01T18:00:00Z') }),
        session({ id: 'new', providerSessionId: 'sNew', startedAt: new Date('2026-01-01T18:30:00Z') }),
      ],
    });
    await enforceAndAct(svc);
    expect(terminate).toHaveBeenCalledWith('plex1', 'sOld', expect.anything());
  });

  it('stops exactly the excess (limit 2, three streams → one stop)', async () => {
    const { svc, terminate } = build({
      settings: SETTINGS({ defaultLimit: 2 }),
      sessions: [
        session({ id: 'a', providerSessionId: 'sA', startedAt: new Date('2026-01-01T18:00:00Z') }),
        session({ id: 'b', providerSessionId: 'sB', startedAt: new Date('2026-01-01T18:10:00Z') }),
        session({ id: 'c', providerSessionId: 'sC', startedAt: new Date('2026-01-01T18:20:00Z') }),
      ],
    });
    await enforceAndAct(svc);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith('plex1', 'sC', expect.anything());
  });

  it('waits out a positive grace period before acting', async () => {
    const { svc, terminate, broadcast } = build({
      settings: SETTINGS({ defaultLimit: 1, gracePeriodSeconds: 30 }),
      sessions: [session({ id: 'a', providerSessionId: 'sA' }), session({ id: 'b', providerSessionId: 'sB' })],
    });
    await svc.enforce();
    expect(terminate).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith('media_server.stream_limit.exceeded', expect.anything());
  });

  it('never acts on the first detection, even with zero grace (waits one poll cycle for fresh state)', async () => {
    const { svc, terminate } = build({
      settings: SETTINGS({ defaultLimit: 1, gracePeriodSeconds: 0 }),
      sessions: [session({ id: 'a', providerSessionId: 'sA' }), session({ id: 'b', providerSessionId: 'sB' })],
    });
    await svc.enforce(); // first pass only arms the grace — a just-paused/moved stream may not be reflected yet
    expect(terminate).not.toHaveBeenCalled();
  });

  it('records a reason with each stream’s playback state (diagnosable)', async () => {
    const { svc, events } = build({
      settings: SETTINGS({ defaultLimit: 1 }),
      sessions: [
        session({ id: 'old', providerSessionId: 'sOld', title: 'Show A', playbackState: 'playing', startedAt: new Date('2026-01-01T18:00:00Z') }),
        session({ id: 'new', providerSessionId: 'sNew', title: 'Show B', playbackState: 'playing', startedAt: new Date('2026-01-01T18:30:00Z') }),
      ],
    });
    await enforceAndAct(svc);
    expect(events[0].reason).toContain('limit of 1');
    expect(events[0].reason).toContain('Show A');
    expect(events[0].reason).toContain('playing');
  });

  it('does not terminate if the account returns to compliance during grace', async () => {
    // First pass over the limit (grace armed), second pass back under → no stop.
    const fp = fakePrisma({ sessions: [session({ id: 'a' }), session({ id: 'b' })], connections: PLEX_ONLINE });
    let sessions = [session({ id: 'a' }), session({ id: 'b' })];
    (fp.prisma.mediaServerSession as any).findMany = async () => sessions;
    const policy = new StreamPolicyService(fp.prisma as never, { read: async () => SETTINGS({ defaultLimit: 1, gracePeriodSeconds: 30 }) } as never);
    const terminate = jest.fn(async () => ({ supported: true, result: { success: true } }));
    const svc = new StreamEnforcementService(
      fp.prisma as never, policy, { terminateSession: terminate } as never,
      { broadcast: jest.fn() } as never, { getStatus: () => ({ enabled: true }) } as never,
      { withLock: async (_k: string, _t: number, fn: () => Promise<unknown>) => ({ ran: true, result: await fn() }), usesRedis: () => false } as never,
    );
    await svc.enforce();
    sessions = [session({ id: 'a' })]; // the second stream ended on its own
    await svc.enforce();
    expect(terminate).not.toHaveBeenCalled();
  });

  it('records a skipped event when the provider cannot terminate (monitor-only)', async () => {
    const terminate = jest.fn(async () => ({ supported: false, message: 'kodi does not support "terminateSession".' }));
    const { svc, events } = build({ settings: SETTINGS({ defaultLimit: 1 }), sessions: [session({ id: 'a' }), session({ id: 'b' })], terminate });
    await enforceAndAct(svc);
    expect(events[0]).toMatchObject({ result: 'skipped' });
  });

  it('records a failure when the provider stop fails', async () => {
    const terminate = jest.fn(async () => ({ supported: true, result: { success: false, message: 'HTTP 500' } }));
    const { svc, events, broadcast } = build({ settings: SETTINGS({ defaultLimit: 1 }), sessions: [session({ id: 'a' }), session({ id: 'b' })], terminate });
    await enforceAndAct(svc);
    expect(events[0]).toMatchObject({ result: 'failure', errorMessage: 'HTTP 500' });
    expect(broadcast).toHaveBeenCalledWith('media_server.stream.termination_failed', expect.anything());
  });

  it('never terminates an exempt subject', async () => {
    const { svc, terminate } = build({
      settings: SETTINGS({ defaultLimit: 1 }),
      subjects: [{ id: 'subjX', kind: 'plex', providerUserId: '100', displayName: 'VIP', exemptFromLimits: true, createdAt: new Date(), updatedAt: new Date() }],
      sessions: [session({ id: 'a' }), session({ id: 'b' })],
    });
    await svc.enforce();
    expect(terminate).not.toHaveBeenCalled();
  });

  it('does not count a paused stream when countPaused is off', async () => {
    const { svc, terminate } = build({
      settings: SETTINGS({ defaultLimit: 1, countPaused: false }),
      sessions: [session({ id: 'a', playbackState: 'playing' }), session({ id: 'b', playbackState: 'paused' })],
    });
    await svc.enforce();
    // Only one playing stream counts → within limit → no termination.
    expect(terminate).not.toHaveBeenCalled();
  });

  it('does not count a stale stream the poller stopped refreshing', async () => {
    const { svc, terminate } = build({
      settings: SETTINGS({ defaultLimit: 1 }),
      sessions: [
        session({ id: 'a', updatedAt: new Date() }),
        session({ id: 'b', updatedAt: new Date(Date.now() - 5 * 60_000) }),
      ],
    });
    await svc.enforce();
    expect(terminate).not.toHaveBeenCalled();
  });

  it('skips a server whose health is not online (uncertain read)', async () => {
    const { svc, terminate } = build({
      settings: SETTINGS({ defaultLimit: 1 }),
      connections: [{ id: 'plex1', kind: 'plex', status: 'offline', capabilities: { terminateSessions: true } }],
      sessions: [session({ id: 'a' }), session({ id: 'b' })],
    });
    await svc.enforce();
    expect(terminate).not.toHaveBeenCalled();
  });

  it('counts LINKED subjects together across products and stops the newest', async () => {
    const groupId = 'grp-1';
    const subjects = [
      { id: 'sp', kind: 'plex', providerUserId: '100', displayName: 'John', exemptFromLimits: false, groupId, createdAt: new Date(), updatedAt: new Date() },
      { id: 'sj', kind: 'jellyfin', providerUserId: 'JF', displayName: 'John', exemptFromLimits: false, groupId, createdAt: new Date(), updatedAt: new Date() },
    ];
    const connections = [
      { id: 'plex1', kind: 'plex', status: 'online', capabilities: { terminateSessions: true } },
      { id: 'jf1', kind: 'jellyfin', status: 'online', capabilities: { terminateSessions: true } },
    ];
    const sessions = [
      session({ id: 'a', providerSessionId: 'sA', connectionId: 'plex1', providerUserId: '100', startedAt: new Date('2026-01-01T18:00:00Z') }),
      session({ id: 'b', providerSessionId: 'sB', connectionId: 'jf1', providerUserId: 'JF', startedAt: new Date('2026-01-01T18:30:00Z') }),
    ];
    const { svc, terminate } = build({ settings: SETTINGS({ defaultLimit: 1 }), sessions, connections, subjects });
    await enforceAndAct(svc);
    // One person, limit 1, two streams across Plex+Jellyfin → newest (Jellyfin) stops.
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledWith('jf1', 'sB', expect.anything());
  });

  it('does not enforce an unresolved identity (no providerUserId)', async () => {
    // Build directly so the null id survives (the helper's ?? would replace it).
    const noId = (id: string) => ({ ...session({ id }), providerUserId: null });
    const { svc, terminate } = build({
      settings: SETTINGS({ defaultLimit: 1 }),
      sessions: [noId('a'), noId('b')],
    });
    await svc.enforce();
    expect(terminate).not.toHaveBeenCalled();
  });
});
