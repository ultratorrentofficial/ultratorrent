import {
  DOMAIN_EVENTS,
  OPERATIONS_EVENT_CHANNEL,
  PERMISSIONS,
  type DomainEventEnvelope,
  type OperationsEvent,
} from '@ultratorrent/shared';
import { OperationsEventBridge } from './operations-event-bridge.service';

/**
 * The bridge does transport, so these tests are about transport's two failure
 * modes: sending an event to the wrong audience, and sending something that was
 * never meant to leave the process.
 */

interface Harness {
  bridge: OperationsEventBridge;
  publish: (envelope: DomainEventEnvelope) => Promise<void>;
  emit: (event: string, payload: unknown, permission: string | null) => void;
  sent: Array<{ permission: string | null; channel: string; event: OperationsEvent }>;
  userLookups: string[];
}

function harness(displayName: string | null = 'Ana Rivera'): Harness {
  let busHandler: ((e: DomainEventEnvelope) => void | Promise<void>) | null = null;
  let observer: ((e: string, p: unknown, perm: string | null) => void) | null = null;
  const sent: Harness['sent'] = [];
  const userLookups: string[] = [];

  const bus = {
    subscribe: (_name: string, handler: (e: DomainEventEnvelope) => void | Promise<void>) => {
      busHandler = handler;
      return () => undefined;
    },
  };
  const realtime = {
    observe: (fn: (e: string, p: unknown, perm: string | null) => void) => {
      observer = fn;
      return () => undefined;
    },
    emitToConsole: (permission: string | null, channel: string, event: OperationsEvent) => {
      sent.push({ permission, channel, event });
    },
  };
  const prisma = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        userLookups.push(where.id);
        return displayName === null ? null : { username: 'ana', displayName };
      },
    },
  };

  const bridge = new OperationsEventBridge(bus as never, realtime as never, prisma as never);
  bridge.onModuleInit();

  return {
    bridge,
    publish: async (envelope) => {
      await busHandler!(envelope);
    },
    emit: (event, payload, permission) => observer!(event, payload, permission),
    sent,
    userLookups,
  };
}

const envelope = (over: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope => ({
  id: 'evt-1',
  eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
  occurredAt: '2026-08-22T12:00:00.000Z',
  payload: { name: 'Some.Release.1080p', engineId: 'e1' },
  ...over,
});

describe('operations event bridge — domain events', () => {
  it('emits to the domain’s permission, not to every console', async () => {
    const h = harness();
    await h.publish(envelope());

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].permission).toBe(PERMISSIONS.TORRENTS_VIEW);
    expect(h.sent[0].channel).toBe(OPERATIONS_EVENT_CHANNEL);
    expect(h.sent[0].event).toMatchObject({
      id: 'evt-1',
      at: '2026-08-22T12:00:00.000Z',
      category: 'torrent',
      severity: 'info',
      facts: { engineId: 'e1' },
    });
  });

  it('drops an event no mapping covers, rather than publishing it unscoped', async () => {
    const h = harness();
    await h.publish(envelope({ eventKey: 'some.unmapped.event' }));
    expect(h.sent).toEqual([]);
  });

  it('carries the actor’s name and never their id', async () => {
    const h = harness();
    await h.publish(envelope({ actorUserId: 'user-42' }));

    expect(h.sent[0].event.actor).toBe('Ana Rivera');
    expect(JSON.stringify(h.sent[0].event)).not.toContain('user-42');
  });

  it('resolves a repeated actor once, not once per event', async () => {
    const h = harness();
    await h.publish(envelope({ id: 'a', actorUserId: 'user-42' }));
    await h.publish(envelope({ id: 'b', actorUserId: 'user-42' }));
    await h.publish(envelope({ id: 'c', actorUserId: 'user-42' }));

    expect(h.userLookups).toEqual(['user-42']);
    expect(h.sent.map((s) => s.event.actor)).toEqual(['Ana Rivera', 'Ana Rivera', 'Ana Rivera']);
  });

  it('still emits when the actor cannot be resolved', async () => {
    // A deleted account must not silence the event it caused.
    const h = harness(null);
    await h.publish(envelope({ actorUserId: 'ghost' }));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].event.actor).toBeNull();
  });

  it('puts no unlisted payload field on the wire', async () => {
    const h = harness();
    await h.publish(
      envelope({
        payload: {
          name: 'Some.Release',
          engineId: 'e1',
          announceUrl: 'https://tracker.example/announce?passkey=SECRET',
          savePath: '/mnt/media/private',
        },
      }),
    );

    const wire = JSON.stringify(h.sent[0].event);
    expect(wire).not.toContain('SECRET');
    expect(wire).not.toContain('/mnt/media/private');
  });
});

describe('operations event bridge — job events observed on the gateway', () => {
  const jobPayload = {
    jobId: 'job-1',
    type: 'media.scan',
    moduleKey: 'media',
    status: 'failed',
    phase: 'indexing',
    progress: 40,
    errorCode: 'E_SCAN',
    errorMessage: 'postgres://user:pw@db/ultratorrent timed out',
    correlationId: 'corr-1',
    at: '2026-08-22T12:00:00.000Z',
  };

  it('re-emits a jobs.* event with the same scoping it was emitted under', () => {
    const h = harness();
    h.emit('jobs.failed', jobPayload, PERMISSIONS.MEDIA_MANAGER_VIEW);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].permission).toBe(PERMISSIONS.MEDIA_MANAGER_VIEW);
    expect(h.sent[0].event).toMatchObject({
      category: 'job',
      severity: 'error',
      resourceType: 'platform_job',
      resourceId: 'job-1',
      correlationId: 'corr-1',
    });
  });

  it('scopes an unscoped job to jobs.view rather than to everyone', () => {
    const h = harness();
    h.emit('jobs.updated', { ...jobPayload, status: 'running' }, null);
    expect(h.sent[0].permission).toBe(PERMISSIONS.JOBS_VIEW);
  });

  it('carries errorCode but never errorMessage', () => {
    // Free text from whatever failed is the one place a connection string
    // plausibly appears — and here it would have.
    const h = harness();
    h.emit('jobs.failed', jobPayload, PERMISSIONS.JOBS_VIEW);

    expect(h.sent[0].event.facts).toMatchObject({ errorCode: 'E_SCAN' });
    expect(JSON.stringify(h.sent[0].event)).not.toContain('postgres://');
  });

  it('gives the same transition a stable id and two transitions different ones', () => {
    const h = harness();
    h.emit('jobs.failed', jobPayload, PERMISSIONS.JOBS_VIEW);
    h.emit('jobs.failed', jobPayload, PERMISSIONS.JOBS_VIEW);
    h.emit('jobs.updated', { ...jobPayload, status: 'running' }, PERMISSIONS.JOBS_VIEW);

    expect(h.sent[0].event.id).toBe(h.sent[1].event.id);
    expect(h.sent[2].event.id).not.toBe(h.sent[0].event.id);
  });

  it('ignores everything on the gateway that is not a job event', () => {
    const h = harness();
    h.emit('torrents.update', { hashes: ['a'] }, PERMISSIONS.TORRENTS_VIEW);
    h.emit(OPERATIONS_EVENT_CHANNEL, { id: 'loop' }, PERMISSIONS.TORRENTS_VIEW);
    h.emit('jobs.failed', 'not-an-object', PERMISSIONS.JOBS_VIEW);
    expect(h.sent).toEqual([]);
  });
});

describe('operations event bridge — lifecycle', () => {
  it('detaches from both sources on destroy', async () => {
    let busOff = 0;
    let observeOff = 0;
    const bus = {
      subscribe: () => () => {
        busOff += 1;
      },
    };
    const realtime = {
      observe: () => () => {
        observeOff += 1;
      },
      emitToConsole: () => undefined,
    };
    const bridge = new OperationsEventBridge(bus as never, realtime as never, {} as never);
    bridge.onModuleInit();
    bridge.onModuleDestroy();

    expect(busOff).toBe(1);
    expect(observeOff).toBe(1);

    // Idempotent: a second destroy must not re-run the unsubscribes.
    bridge.onModuleDestroy();
    expect(busOff).toBe(1);
  });
});
