import { EventEmitter2 } from '@nestjs/event-emitter';
import { DOMAIN_EVENTS } from '@ultratorrent/shared';
import { DomainEventBus } from '../domain-events/domain-event-bus.service';
import { AutomationEventBridge } from './automation-event.bridge';

function build(engineOver: Partial<{ evaluateEvent: jest.Mock }> = {}) {
  const calls: Array<{ trigger: string; context: Record<string, unknown> }> = [];
  const engine: any = {
    evaluateEvent:
      engineOver.evaluateEvent ??
      jest.fn(async (trigger: string, context: Record<string, unknown>) => {
        calls.push({ trigger, context });
      }),
  };
  const bus = new DomainEventBus(new EventEmitter2({ wildcard: true, delimiter: '.' }));
  // Mirrors the lazy ModuleRef lookup the bridge uses to break the import cycle.
  const moduleRef: any = { get: () => engine };
  const bridge = new AutomationEventBridge(bus, moduleRef);
  bridge.onModuleInit();
  return { bridge, bus, engine, calls };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('AutomationEventBridge', () => {
  it('evaluates rules for the published event key', async () => {
    const { bus, calls } = build();
    bus.publish({
      eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
      resourceType: 'torrent',
      resourceId: 'h1',
      payload: { torrentName: 'Dune', hash: 'h1' },
    });
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].trigger).toBe(DOMAIN_EVENTS.TORRENT_COMPLETED);
    expect(calls[0].context).toMatchObject({ torrentName: 'Dune', hash: 'h1' });
  });

  it('flattens envelope identity beside the payload so conditions can match it', async () => {
    const { bus, calls } = build();
    bus.publish({
      eventKey: DOMAIN_EVENTS.USER_ROLE_CHANGED,
      actorUserId: 'admin-1',
      subjectUserId: 'user-9',
      resourceType: 'user',
      resourceId: 'user-9',
      payload: { username: 'dennis' },
    });
    await flush();

    expect(calls[0].context).toMatchObject({
      username: 'dennis',
      actorUserId: 'admin-1',
      subjectUserId: 'user-9',
      resourceType: 'user',
      resourceId: 'user-9',
      eventKey: DOMAIN_EVENTS.USER_ROLE_CHANGED,
    });
  });

  it('never lets a rule failure escape to the bus', async () => {
    const { bus, engine } = build({
      evaluateEvent: jest.fn(async () => {
        throw new Error('rule exploded');
      }),
    });

    expect(() =>
      bus.publish({
        eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
        resourceType: 'torrent',
        resourceId: 'h2',
        payload: { torrentName: 'x', hash: 'h2' },
      }),
    ).not.toThrow();
    await flush();
    expect(engine.evaluateEvent).toHaveBeenCalledTimes(1);
  });

  it('is not reached by an event the catalogue refused', async () => {
    const { bus, engine } = build();
    bus.publish({ eventKey: 'not.registered', payload: {} });
    await flush();
    expect(engine.evaluateEvent).not.toHaveBeenCalled();
  });

  it('sees a deduped event only once', async () => {
    const { bus, engine } = build();
    const failed = {
      eventKey: DOMAIN_EVENTS.TORRENT_FAILED,
      resourceType: 'torrent',
      resourceId: 'h3',
      payload: { torrentName: 'x', hash: 'h3' },
    };
    bus.publish(failed);
    bus.publish(failed);
    await flush();
    expect(engine.evaluateEvent).toHaveBeenCalledTimes(1);
  });

  it('stops receiving after unsubscribe', async () => {
    const { bridge, bus, engine } = build();
    bridge.onModuleDestroy();
    bus.publish({
      eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
      resourceType: 'torrent',
      resourceId: 'h4',
      payload: { torrentName: 'x', hash: 'h4' },
    });
    await flush();
    expect(engine.evaluateEvent).not.toHaveBeenCalled();
  });
});
