import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { SchedulerSweepService } from './scheduler-sweep.service';
import { getDomainEventDefinition } from '../domain-events/domain-event-catalog';

/**
 * Scheduler events describe transitions, not heartbeats.
 *
 * The sweep runs every minute and reconciles the same state each time. An event
 * per tick is noise an operator learns to ignore, which is worse than no event —
 * so health is published only when it DIFFERS from the stored value, and the
 * repeating facts carry a dedupe window in the catalogue.
 */
function harness(configs: Array<{ engineId: string; mode: string; healthState?: string }>) {
  const published: any[] = [];
  const prisma = {
    torrentSchedulerEngineConfig: {
      findMany: jest.fn(async (args: any) =>
        args?.select?.healthState
          ? configs.map((c) => ({ engineId: c.engineId, healthState: c.healthState ?? 'unknown' }))
          : configs),
      upsert: jest.fn(async (a: any) => a),
    },
    torrentSchedulerDecision: {
      create: jest.fn(async (a: any) => a),
      deleteMany: jest.fn(async () => ({ count: 0 })),
    },
  };
  const registry = {
    list: jest.fn(() => configs.map((c) => ({ engineId: c.engineId, kind: 'qbittorrent' }))),
    get: jest.fn((engineId: string) => ({ engineId, kind: 'qbittorrent' })),
  };
  const preview = {
    previewEngine: jest.fn(async (engineId: string) => ({
      engineId,
      decisions: [
        { hash: 'seedy', action: 'pause', reasonCode: 'seed_target_reached', values: { ratio: 2.5 } },
        { hash: 'other', action: 'none', reasonCode: 'seeding_within_limit' },
      ],
      summary: {}, limitations: [],
    })),
  };
  const reconciliation = {
    apply: jest.fn(async () => ({
      engineId: 'e1', attempted: 1, applied: 0, failed: 1, unverified: 0,
      limitations: [], failures: [{ hash: 'broken', action: 'pause', error: '403' }],
    })),
  };
  const bus = { publish: jest.fn((e: any) => { published.push(e); return { published: true }; }) };

  const svc = new SchedulerSweepService(
    prisma as never, registry as never, preview as never, reconciliation as never, bus as never,
  );
  return { svc, published, bus };
}

const keysOf = (published: any[]) => published.map((p) => p.eventKey);

describe('health is an event only when it changes', () => {
  it('announces a change from the stored state', async () => {
    const { svc, published } = harness([{ engineId: 'e1', mode: 'observe', healthState: 'degraded' }]);
    await svc.tick();

    const health = published.filter((p) => p.eventKey === DOMAIN_EVENTS.TORRENT_SCHEDULER_HEALTH_CHANGED);
    expect(health).toHaveLength(1);
    expect(health[0].payload).toMatchObject({ healthState: 'healthy', previousHealthState: 'degraded' });
  });

  it('says nothing when health is unchanged', async () => {
    // The property that separates an event from a heartbeat: a healthy engine
    // sweeping every minute must not announce its health every minute.
    const { svc, published } = harness([{ engineId: 'e1', mode: 'observe', healthState: 'healthy' }]);
    await svc.tick();

    expect(keysOf(published)).not.toContain(DOMAIN_EVENTS.TORRENT_SCHEDULER_HEALTH_CHANGED);
  });
});

describe('what the sweep publishes', () => {
  it('announces a seed that met its target', async () => {
    const { svc, published } = harness([{ engineId: 'e1', mode: 'observe' }]);
    await svc.tick();

    const seed = published.find((p) => p.eventKey === DOMAIN_EVENTS.TORRENT_SCHEDULER_SEED_TARGET_REACHED);
    expect(seed).toBeDefined();
    expect(seed.resourceId).toBe('seedy');
    expect(seed.payload).toMatchObject({ torrentHash: 'seedy', ratio: 2.5 });
  });

  it('does not announce a torrent that merely kept seeding', async () => {
    const { svc, published } = harness([{ engineId: 'e1', mode: 'observe' }]);
    await svc.tick();
    const seeds = published.filter(
      (p) => p.eventKey === DOMAIN_EVENTS.TORRENT_SCHEDULER_SEED_TARGET_REACHED,
    );
    expect(seeds.map((s) => s.resourceId)).toEqual(['seedy']);
  });

  it('announces a failed action only when enforcement actually ran', async () => {
    // Observing produces no actions, so it can produce no action failures.
    const observing = harness([{ engineId: 'e1', mode: 'observe' }]);
    await observing.svc.tick();
    expect(keysOf(observing.published)).not.toContain(DOMAIN_EVENTS.TORRENT_SCHEDULER_ACTION_FAILED);

    const managed = harness([{ engineId: 'e1', mode: 'managed' }]);
    await managed.svc.tick();
    const failed = managed.published.find(
      (p) => p.eventKey === DOMAIN_EVENTS.TORRENT_SCHEDULER_ACTION_FAILED,
    );
    expect(failed.payload).toMatchObject({ torrentHash: 'broken', action: 'pause', error: '403' });
  });

  it('publishes nothing for a native engine', async () => {
    const { svc, published } = harness([{ engineId: 'e1', mode: 'native' }]);
    await svc.tick();
    expect(published).toHaveLength(0);
  });
});

describe('the event catalogue', () => {
  it('registers all four, so the bus will accept them', () => {
    // An unregistered key is refused at publish time, silently as far as the
    // caller is concerned — the bus never throws.
    for (const key of [
      DOMAIN_EVENTS.TORRENT_SCHEDULER_MODE_CHANGED,
      DOMAIN_EVENTS.TORRENT_SCHEDULER_HEALTH_CHANGED,
      DOMAIN_EVENTS.TORRENT_SCHEDULER_SEED_TARGET_REACHED,
      DOMAIN_EVENTS.TORRENT_SCHEDULER_ACTION_FAILED,
    ]) {
      expect(getDomainEventDefinition(key)).toBeDefined();
    }
  });

  it('gives the repeating facts a dedupe window, and the discrete one none', () => {
    /*
     * The sweep re-derives a met seed target every minute for as long as the
     * torrent stays complete, so without a window it would announce forever.
     * A mode change is an operator's discrete act — two in a minute are two
     * facts, and deduping them would hide the second.
     */
    expect(getDomainEventDefinition(DOMAIN_EVENTS.TORRENT_SCHEDULER_SEED_TARGET_REACHED)
      ?.deduplicationWindowSeconds).toBeGreaterThan(0);
    expect(getDomainEventDefinition(DOMAIN_EVENTS.TORRENT_SCHEDULER_ACTION_FAILED)
      ?.deduplicationWindowSeconds).toBeGreaterThan(0);
    expect(getDomainEventDefinition(DOMAIN_EVENTS.TORRENT_SCHEDULER_MODE_CHANGED)
      ?.deduplicationWindowSeconds).toBeUndefined();
  });

  it('requires the fields a consumer needs to route and describe the event', () => {
    expect(getDomainEventDefinition(DOMAIN_EVENTS.TORRENT_SCHEDULER_ACTION_FAILED)?.requiredFields)
      .toEqual(expect.arrayContaining(['engineId', 'torrentHash', 'action']));
  });
});
