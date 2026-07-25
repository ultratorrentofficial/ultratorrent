import { EventEmitter2 } from '@nestjs/event-emitter';
import { DOMAIN_EVENTS, DOMAIN_EVENT_CHANNEL, type DomainEventEnvelope } from '@ultratorrent/shared';
import { DomainEventBus } from './domain-event-bus.service';
import { allDomainEventDefinitions, getDomainEventDefinition } from './domain-event-catalog';

function make() {
  const emitter = new EventEmitter2({ wildcard: true, delimiter: '.' });
  return { bus: new DomainEventBus(emitter), emitter };
}

/** A minimal valid publish for an event with required fields. */
const torrentDone = (over: Record<string, unknown> = {}) => ({
  eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
  resourceType: 'torrent',
  resourceId: 'h1',
  payload: { torrentName: 'Dune.2021.1080p', hash: 'h1' },
  ...over,
});

describe('DomainEventBus — publish', () => {
  it('publishes a valid event and stamps id + occurredAt', () => {
    const { bus, emitter } = make();
    const seen: DomainEventEnvelope[] = [];
    emitter.on(DOMAIN_EVENT_CHANNEL, (e: DomainEventEnvelope) => { seen.push(e); });

    const result = bus.publish(torrentDone());

    expect(result.published).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBeTruthy();
    expect(Number.isNaN(Date.parse(seen[0].occurredAt))).toBe(false);
    expect(seen[0].eventKey).toBe(DOMAIN_EVENTS.TORRENT_COMPLETED);
  });

  it('refuses an unregistered key rather than inventing vocabulary', () => {
    const { bus, emitter } = make();
    const seen: unknown[] = [];
    emitter.on(DOMAIN_EVENT_CHANNEL, (e) => { seen.push(e); });

    const result = bus.publish({ eventKey: 'made.up_event', payload: {} });

    expect(result).toMatchObject({ published: false, reason: 'unregistered' });
    expect(seen).toHaveLength(0);
  });

  it('refuses a payload missing a field consumers need', () => {
    const { bus, emitter } = make();
    const seen: unknown[] = [];
    emitter.on(DOMAIN_EVENT_CHANNEL, (e) => { seen.push(e); });

    // `hash` is required by the catalogue.
    const result = bus.publish(torrentDone({ payload: { torrentName: 'x' } }));

    expect(result.published).toBe(false);
    expect(result.reason).toBe('invalid_payload');
    expect(result.problems).toContain('payload.hash is required');
    expect(seen).toHaveLength(0);
  });

  it('treats a null field as missing, not as present', () => {
    const { bus } = make();
    const result = bus.publish(torrentDone({ payload: { torrentName: 'x', hash: null } }));
    expect(result.published).toBe(false);
    expect(result.problems).toContain('payload.hash is required');
  });

  it('never throws at the caller — a bad event must not fail the operation', () => {
    const { bus } = make();
    expect(() => bus.publish({ eventKey: 'nope', payload: undefined as never })).not.toThrow();
  });
});

describe('DomainEventBus — idempotency', () => {
  it('publishes the same event id once', () => {
    const { bus, emitter } = make();
    const seen: unknown[] = [];
    emitter.on(DOMAIN_EVENT_CHANNEL, (e) => { seen.push(e); });

    const first = bus.publish(torrentDone({ id: 'evt-1' }));
    const second = bus.publish(torrentDone({ id: 'evt-1' }));

    expect(first.published).toBe(true);
    expect(second).toMatchObject({ published: false, reason: 'duplicate' });
    expect(seen).toHaveLength(1);
  });

  it('suppresses a repeated FACT inside its dedupe window', () => {
    const { bus, emitter } = make();
    const seen: unknown[] = [];
    emitter.on(DOMAIN_EVENT_CHANNEL, (e) => { seen.push(e); });

    // `torrent.failed` has a 1h window: the sync loop sees the error state every tick.
    const failed = {
      eventKey: DOMAIN_EVENTS.TORRENT_FAILED,
      resourceType: 'torrent',
      resourceId: 'h9',
      payload: { torrentName: 'x', hash: 'h9' },
    };
    bus.publish(failed);
    bus.publish(failed);
    bus.publish(failed);

    expect(seen).toHaveLength(1);
  });

  it('scopes the fact window per resource, not per event key', () => {
    const { bus, emitter } = make();
    const seen: unknown[] = [];
    emitter.on(DOMAIN_EVENT_CHANNEL, (e) => { seen.push(e); });

    for (const hash of ['a', 'b']) {
      bus.publish({
        eventKey: DOMAIN_EVENTS.TORRENT_FAILED,
        resourceType: 'torrent',
        resourceId: hash,
        payload: { torrentName: hash, hash },
      });
    }
    // Two different torrents failing are two facts.
    expect(seen).toHaveLength(2);
  });

  it('does not dedupe events whose definition sets no window', () => {
    const { bus, emitter } = make();
    const seen: unknown[] = [];
    emitter.on(DOMAIN_EVENT_CHANNEL, (e) => { seen.push(e); });

    // `torrent.completed` has no window — two genuine completions must both land.
    bus.publish(torrentDone());
    bus.publish(torrentDone());

    expect(seen).toHaveLength(2);
  });
});

describe('DomainEventBus — subscriber isolation', () => {
  it('one throwing subscriber does not stop the next', () => {
    const { bus } = make();
    const ran: string[] = [];

    bus.subscribe('bad', () => {
      ran.push('bad');
      throw new Error('boom');
    });
    bus.subscribe('good', () => {
      ran.push('good');
    });

    expect(() => bus.publish(torrentDone())).not.toThrow();
    expect(ran).toEqual(['bad', 'good']);
  });

  it('contains a rejected async subscriber', async () => {
    const { bus } = make();
    const ran: string[] = [];

    bus.subscribe('async-bad', async () => {
      ran.push('async-bad');
      throw new Error('async boom');
    });
    bus.subscribe('after', () => { ran.push('after'); });

    expect(() => bus.publish(torrentDone())).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(ran).toEqual(['async-bad', 'after']);
  });

  it('unsubscribes cleanly', () => {
    const { bus } = make();
    const ran: string[] = [];
    const off = bus.subscribe('temp', () => { ran.push('hit'); });

    bus.publish(torrentDone({ id: 'e1' }));
    off();
    bus.publish(torrentDone({ id: 'e2' }));

    expect(ran).toEqual(['hit']);
  });
});

describe('domain event catalogue', () => {
  it('registers every key exactly once', () => {
    const keys = allDomainEventDefinitions().map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('covers every key exported from shared', () => {
    for (const key of Object.values(DOMAIN_EVENTS)) {
      expect(getDomainEventDefinition(key)).toBeDefined();
    }
  });

  it('registers no key that shared does not declare', () => {
    const declared = new Set<string>(Object.values(DOMAIN_EVENTS));
    for (const definition of allDomainEventDefinitions()) {
      expect(declared.has(definition.key)).toBe(true);
    }
  });

  it('gives every polled event a dedupe window', () => {
    // These have producers that re-observe the same state on a timer; without a
    // window each would republish on every tick.
    for (const key of [
      DOMAIN_EVENTS.TORRENT_FAILED,
      DOMAIN_EVENTS.PROVIDER_OFFLINE,
      DOMAIN_EVENTS.SYSTEM_STORAGE_CRITICAL,
      DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING,
    ]) {
      expect(getDomainEventDefinition(key)!.deduplicationWindowSeconds).toBeGreaterThan(0);
    }
  });
});
