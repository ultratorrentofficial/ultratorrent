import { DOMAIN_EVENTS, PERMISSIONS, type DomainEventEnvelope } from '@ultratorrent/shared';
import { factsFor, jobSeverity, mappedEventKeys, mappingFor } from './operations-event-map';

/**
 * The event map is the console stream's security boundary, so these tests are
 * about what must NOT happen: an event reaching a reader who lacks the domain
 * permission, and a payload field reaching the wire because nobody listed it.
 */

const envelope = (over: Partial<DomainEventEnvelope> = {}): DomainEventEnvelope => ({
  id: 'evt-1',
  eventKey: DOMAIN_EVENTS.TORRENT_COMPLETED,
  occurredAt: '2026-08-22T00:00:00.000Z',
  payload: {},
  ...over,
});

describe('operations event map — an unmapped event does not travel', () => {
  it('returns null for a key nobody has mapped', () => {
    expect(mappingFor('some.future.event')).toBeNull();
  });

  it('returns null rather than throwing for a key that is not a string key at all', () => {
    // Prototype keys must not resolve to a mapping — `mappingFor('toString')`
    // finding Object.prototype.toString would publish an event with a function
    // where its permission should be.
    expect(mappingFor('toString')).toBeNull();
    expect(mappingFor('constructor')).toBeNull();
  });
});

describe('operations event map — every mapping is scoped', () => {
  const keys = mappedEventKeys();

  it('maps a meaningful share of the catalogue', () => {
    expect(keys.length).toBeGreaterThan(15);
  });

  it.each(keys)('%s carries a permission, a category and a severity', (key) => {
    const mapping = mappingFor(key)!;
    expect(mapping).not.toBeNull();
    // `null` is allowed by the type but nothing should be using it: every event
    // in the catalogue belongs to some domain, and "everyone with a console"
    // is not a domain.
    expect(typeof mapping.permission).toBe('string');
    expect(mapping.category).toBeTruthy();
    expect(['info', 'warning', 'error', 'critical']).toContain(mapping.severity);
  });

  it.each(keys)('%s produces a non-empty one-line summary from an empty payload', (key) => {
    const mapping = mappingFor(key)!;
    const summary = mapping.summary({}, envelope({ eventKey: key }));
    expect(summary).toBeTruthy();
    expect(summary).not.toContain('\n');
    // A producer omitting a field must degrade to a readable line, never to
    // "undefined" printed at an operator.
    expect(summary).not.toMatch(/undefined|\[object/);
  });

  it('scopes playback on the live-activity permission, not analytics at large', () => {
    expect(mappingFor(DOMAIN_EVENTS.MEDIA_SERVER_USER_STARTED_WATCHING)!.permission).toBe(
      PERMISSIONS.MEDIA_SERVER_ANALYTICS_VIEW_LIVE_ACTIVITY,
    );
  });

  it('scopes security events on audit.view', () => {
    expect(mappingFor(DOMAIN_EVENTS.SECURITY_LOGIN_FAILED)!.permission).toBe(
      PERMISSIONS.AUDIT_VIEW,
    );
  });
});

describe('operations event map — facts are allowlisted', () => {
  it('drops a payload key no mapping asked for', () => {
    const mapping = mappingFor(DOMAIN_EVENTS.TORRENT_COMPLETED)!;
    const facts = factsFor(mapping, {
      engineId: 'engine-1',
      apiKey: 'super-secret',
      announceUrl: 'https://tracker.example/announce?passkey=abc',
    });
    expect(facts).toEqual({ engineId: 'engine-1' });
  });

  it('drops a non-scalar even when its key IS allowlisted', () => {
    // Flattening is how a payload's private corners reach the wire one level
    // down, so an object is dropped rather than expanded.
    const mapping = mappingFor(DOMAIN_EVENTS.TORRENT_COMPLETED)!;
    expect(factsFor(mapping, { engineId: { id: 'engine-1', password: 'p' } })).toEqual({});
  });

  it('drops NaN and Infinity rather than putting them on the wire', () => {
    const mapping = mappingFor(DOMAIN_EVENTS.SYSTEM_STORAGE_WARNING)!;
    expect(factsFor(mapping, { path: '/data', percentUsed: NaN })).toEqual({ path: '/data' });
  });

  it('keeps a failed login anonymous', () => {
    const mapping = mappingFor(DOMAIN_EVENTS.SECURITY_LOGIN_FAILED)!;
    const facts = factsFor(mapping, { username: 'admin', ipAddress: '10.0.0.5' });
    expect(facts).toEqual({});
    expect(mapping.summary({ username: 'admin' }, envelope())).not.toContain('admin');
  });
});

describe('operations event map — file paths are not disclosed whole', () => {
  it('summarises a move by file name, not by absolute path', () => {
    const mapping = mappingFor(DOMAIN_EVENTS.FILE_MOVED)!;
    const summary = mapping.summary(
      { from: '/srv/staging/incoming/Film.2024.mkv', to: '/mnt/media/Movies/Film (2024)/Film.mkv' },
      envelope(),
    );
    expect(summary).toContain('Film.2024.mkv');
    expect(summary).toContain('Film.mkv');
    expect(summary).not.toContain('/srv/staging');
    expect(summary).not.toContain('/mnt/media');
  });

  it('carries no facts for a file event, so no path travels as data either', () => {
    expect(factsFor(mappingFor(DOMAIN_EVENTS.FILE_MOVED)!, { from: '/a/b', to: '/c/d' })).toEqual(
      {},
    );
  });
});

describe('operations event map — job severity', () => {
  it('reads a failure as an error and a stall as a warning', () => {
    expect(jobSeverity('failed')).toBe('error');
    expect(jobSeverity('stalled')).toBe('warning');
    expect(jobSeverity('completed_with_warnings')).toBe('warning');
  });

  it('treats an unrecognised status as informational rather than alarming', () => {
    expect(jobSeverity('running')).toBe('info');
    expect(jobSeverity('something-new')).toBe('info');
  });
});
