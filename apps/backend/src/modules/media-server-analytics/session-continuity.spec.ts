import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { MediaServerSessionService } from './media-server-session.service';

/**
 * Session continuity across polls.
 *
 * A media server drops a session from its list transiently — buffering, a
 * transcode decision change, or a client re-registering with a new id. Ending on
 * the first miss turned one viewing into several rows, which produced "finished
 * watching" followed immediately by "resumed watching", fragmented the watch
 * history, and inflated the completed-play counts Library Cleanup uses to decide
 * what is safe to delete.
 *
 * Everything here is about behaviour ACROSS polls, which is why it needs a
 * harness that survives more than one.
 */
describe('session continuity', () => {
  const build = () => {
    let nextId = 1;
    const store: any[] = [];
    const history: any[] = [];
    const published: any[] = [];

    const prisma: any = {
      mediaServerIntegration: {
        findMany: jest.fn(async () => [{ id: 'c1', name: 'Plex', isEnabled: true }]),
      },
      mediaServerSession: {
        findMany: jest.fn(async ({ where }: any) =>
          store.filter((r) => r.connectionId === where.connectionId).map((r) => ({ ...r })),
        ),
        findUnique: jest.fn(async ({ where }: any) =>
          store.find((r) => r.id === where.id) ?? null,
        ),
        create: jest.fn(async ({ data }: any) => {
          const row = { id: `s${nextId++}`, missedPolls: 0, startedAt: new Date(), ...data };
          store.push(row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: any) => {
          const row = store.find((r) => r.id === where.id);
          Object.assign(row, data);
          return row;
        }),
        delete: jest.fn(async ({ where }: any) => {
          const i = store.findIndex((r) => r.id === where.id);
          return store.splice(i, 1)[0];
        }),
      },
      mediaServerWatchHistory: {
        create: jest.fn(async ({ data }: any) => { history.push(data); return data; }),
      },
    };

    let sessions: any[] = [];
    const integrations: any = {
      sessions: jest.fn(async () => ({ supported: true, sessions })),
    };
    const realtime: any = { broadcast: jest.fn() };
    const registry: any = { isEnabled: jest.fn(async () => true) };
    const bus: any = {
      publish: jest.fn((e: any) => { published.push(e); return { published: true }; }),
    };

    const svc = new MediaServerSessionService(prisma, integrations, realtime, registry, bus);
    return {
      svc, store, history, published,
      setSessions: (next: any[]) => { sessions = next; },
      starts: () => published.filter((e) => e.eventKey === DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING),
      stops: () => published.filter((e) => e.eventKey === DOMAIN_EVENTS.MEDIA_SERVER_USER_STOPPED_WATCHING),
    };
  };

  const session = (over: Record<string, unknown> = {}) => ({
    sessionId: 'p1', userName: 'madeline24', title: 'FROM — Best Laid Plans',
    device: 'Roku', client: 'Plex for Roku', progressPercent: 58, ...over,
  });

  it('publishes one start for a session that keeps playing', async () => {
    const t = build();
    t.setSessions([session()]);
    await t.svc.poll();
    await t.svc.poll();
    await t.svc.poll();
    expect(t.starts()).toHaveLength(1);
    expect(t.stops()).toHaveLength(0);
  });

  it('does not end a session that vanishes for a single poll', async () => {
    const t = build();
    t.setSessions([session()]);
    await t.svc.poll();

    t.setSessions([]);            // Plex omitted it once
    await t.svc.poll();
    expect(t.stops()).toHaveLength(0);

    t.setSessions([session({ progressPercent: 61 })]);
    await t.svc.poll();
    // The whole bug: this used to be a stop followed by a start.
    expect(t.stops()).toHaveLength(0);
    expect(t.starts()).toHaveLength(1);
    expect(t.history).toHaveLength(0);
  });

  it('ends the session once the grace period is exhausted', async () => {
    const t = build();
    t.setSessions([session()]);
    await t.svc.poll();

    t.setSessions([]);
    for (let i = 0; i < 4; i += 1) await t.svc.poll();

    expect(t.stops()).toHaveLength(1);
    expect(t.history).toHaveLength(1);
    expect(t.store).toHaveLength(0);
  });

  it('re-attaches a session whose provider id changed mid-playback', async () => {
    const t = build();
    t.setSessions([session({ sessionId: 'p1', progressPercent: 58 })]);
    await t.svc.poll();

    // Same person, same title, same device — a re-registered client.
    t.setSessions([session({ sessionId: 'p2-renumbered', progressPercent: 97 })]);
    await t.svc.poll();

    expect(t.starts()).toHaveLength(1);
    expect(t.stops()).toHaveLength(0);
    // One row, now tracking the new id, with the original start preserved.
    expect(t.store).toHaveLength(1);
    expect(t.store[0].providerSessionId).toBe('p2-renumbered');
    expect(t.store[0].progressPercent).toBe(97);
  });

  it('resets the miss counter when a session comes back', async () => {
    const t = build();
    t.setSessions([session()]);
    await t.svc.poll();

    t.setSessions([]);
    await t.svc.poll();
    await t.svc.poll();
    expect(t.store[0].missedPolls).toBe(2);

    t.setSessions([session()]);
    await t.svc.poll();
    expect(t.store[0].missedPolls).toBe(0);

    // And the budget is full again, not carried over.
    t.setSessions([]);
    for (let i = 0; i < 3; i += 1) await t.svc.poll();
    expect(t.stops()).toHaveLength(0);
  });

  it('does not swallow a second person watching the same title', async () => {
    const t = build();
    t.setSessions([
      session({ sessionId: 'a', userName: 'madeline24', device: 'Roku' }),
      session({ sessionId: 'b', userName: 'dennis.ayala', device: 'Apple TV' }),
    ]);
    await t.svc.poll();
    expect(t.starts()).toHaveLength(2);
    expect(t.store).toHaveLength(2);

    // One re-registers; the other must not be adopted into it.
    t.setSessions([
      session({ sessionId: 'a2', userName: 'madeline24', device: 'Roku' }),
      session({ sessionId: 'b', userName: 'dennis.ayala', device: 'Apple TV' }),
    ]);
    await t.svc.poll();
    expect(t.starts()).toHaveLength(2);
    expect(t.stops()).toHaveLength(0);
    expect(t.store).toHaveLength(2);
  });

  it('does not adopt an active session belonging to another id', async () => {
    // Both still present: nothing has disappeared, so nothing may be adopted.
    const t = build();
    t.setSessions([
      session({ sessionId: 'a', device: 'Roku' }),
      session({ sessionId: 'b', device: 'Bedroom TV' }),
    ]);
    await t.svc.poll();
    await t.svc.poll();
    expect(t.store).toHaveLength(2);
    expect(t.starts()).toHaveLength(2);
  });

  it('still reports a genuine stop, only later', async () => {
    const t = build();
    t.setSessions([session({ progressPercent: 96 })]);
    await t.svc.poll();

    t.setSessions([]);
    for (let i = 0; i < 4; i += 1) await t.svc.poll();

    const stop = t.stops()[0];
    expect(stop.payload.mediaTitle).toBe('FROM — Best Laid Plans');
    // The final progress observed while it was playing, not a re-derived value.
    expect(t.history[0].percentComplete).toBe(96);
  });

  it('writes one history row per viewing, not one per poll gap', async () => {
    const t = build();
    t.setSessions([session({ progressPercent: 58 })]);
    await t.svc.poll();

    // The exact shape seen live: brief absence, return, id change, return.
    t.setSessions([]);
    await t.svc.poll();
    t.setSessions([session({ sessionId: 'p2', progressPercent: 97 })]);
    await t.svc.poll();
    t.setSessions([]);
    await t.svc.poll();
    t.setSessions([session({ sessionId: 'p3', progressPercent: 99 })]);
    await t.svc.poll();

    expect(t.history).toHaveLength(0); // still playing
    t.setSessions([]);
    for (let i = 0; i < 4; i += 1) await t.svc.poll();

    // Previously four rows and two spurious completed plays.
    expect(t.history).toHaveLength(1);
    expect(t.history[0].percentComplete).toBe(99);
    expect(t.starts()).toHaveLength(1);
    expect(t.stops()).toHaveLength(1);
  });
});
