import type {
  OperationsEngine,
  OperationsIndexer,
  OperationsJobs,
  OperationsProvider,
  OperationsStorage,
  OperationsSystem,
} from '@ultratorrent/shared';
import {
  LOAD_CRITICAL_PER_CORE,
  LOAD_WARNING_PER_CORE,
  STORAGE_CRITICAL_AT,
  STORAGE_WARNING_AT,
  projectAlerts,
  sortAlerts,
} from './operations-alerts';

/**
 * The alert projection is pure, so these are the real thresholds and the real
 * ordering — not a stub of them. What is worth testing here is the two
 * properties an operator's trust rests on: a condition produces exactly one
 * alert with a stable id, and an input the caller was NOT permitted to read
 * produces none at all.
 */

const system = (over: Partial<OperationsSystem> = {}): OperationsSystem => ({
  product: 'UltraTorrent',
  version: '0.85.7',
  apiVersion: 'v1',
  gitSha: null,
  gitTag: null,
  buildTime: null,
  nodeVersion: 'v20.0.0',
  uptimeSeconds: 1000,
  memoryBytes: 1024,
  loadAverage: [0.1, 0.1, 0.1],
  cpuCount: 4,
  database: 'healthy',
  cache: 'unknown',
  ...over,
});

const storage = (usedPercent: number | null, path = '/data'): OperationsStorage => ({
  roots: [
    {
      path,
      totalBytes: 100,
      freeBytes: 1,
      usedBytes: 99,
      usedPercent,
      health: usedPercent === null ? 'unknown' : 'healthy',
      ...(usedPercent === null ? { error: 'EACCES' } : {}),
    },
  ],
});

const engine = (over: Partial<OperationsEngine> = {}): OperationsEngine => ({
  engineId: 'engine-1',
  kind: 'qbittorrent',
  health: 'healthy',
  lastSeenAt: null,
  error: null,
  version: null,
  torrentCount: 0,
  ...over,
});

const indexer = (over: Partial<OperationsIndexer> = {}): OperationsIndexer => ({
  id: 'i1',
  name: 'Nyaa',
  implementation: 'torznab',
  protocol: 'torrent',
  enabled: true,
  priority: 25,
  health: 'healthy',
  message: null,
  lastTestedAt: null,
  ...over,
});

const provider = (over: Partial<OperationsProvider> = {}): OperationsProvider => ({
  category: 'media_server',
  key: 'plex',
  name: 'Plex',
  enabled: true,
  health: 'healthy',
  message: null,
  version: null,
  lastCheckedAt: null,
  capabilities: [],
  ...over,
});

const jobs = (over: Partial<OperationsJobs> = {}): OperationsJobs => ({
  byStatus: {},
  running: 0,
  queued: 0,
  failed: 0,
  active: 0,
  completedToday: 0,
  failedToday: 0,
  successRate: null,
  recent: [],
  truncated: false,
  ...over,
});

describe('operations alerts — storage thresholds', () => {
  it('is silent below the warning threshold', () => {
    const percent = STORAGE_WARNING_AT * 100 - 1;
    expect(projectAlerts({ storage: storage(percent) })).toEqual([]);
  });

  it('warns at the warning threshold and escalates at the critical one', () => {
    const warned = projectAlerts({ storage: storage(STORAGE_WARNING_AT * 100) });
    expect(warned).toHaveLength(1);
    expect(warned[0].severity).toBe('warning');

    const critical = projectAlerts({ storage: storage(STORAGE_CRITICAL_AT * 100) });
    expect(critical).toHaveLength(1);
    expect(critical[0].severity).toBe('critical');
  });

  it('raises exactly one alert per root, not one warning plus one critical', () => {
    // The `else if` is the point: a full disk is one problem, and reporting it
    // twice at two severities is how an attention list stops being read.
    const alerts = projectAlerts({ storage: storage(99) });
    expect(alerts).toHaveLength(1);
  });

  it('reports an unmeasurable root rather than treating it as empty', () => {
    const alerts = projectAlerts({ storage: storage(null) });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].id).toBe('storage:root_unreadable:/data');
  });
});

describe('operations alerts — load is measured per core', () => {
  it('does not alert on a load that is high in absolute terms but low per core', () => {
    // 6.0 across 64 cores is an idle machine. A fixed threshold would page.
    expect(
      projectAlerts({ system: system({ loadAverage: [6, 6, 6], cpuCount: 64 }) }),
    ).toEqual([]);
  });

  it('warns then escalates as load per core crosses each threshold', () => {
    const warn = projectAlerts({
      system: system({ loadAverage: [LOAD_WARNING_PER_CORE * 4, 0, 0], cpuCount: 4 }),
    });
    expect(warn.map((a) => a.severity)).toEqual(['warning']);

    const err = projectAlerts({
      system: system({ loadAverage: [LOAD_CRITICAL_PER_CORE * 4, 0, 0], cpuCount: 4 }),
    });
    expect(err.map((a) => a.severity)).toEqual(['error']);
  });

  it('does not divide by zero when the core count is unknown', () => {
    expect(() =>
      projectAlerts({ system: system({ loadAverage: [10, 10, 10], cpuCount: 0 }) }),
    ).not.toThrow();
  });
});

describe('operations alerts — ids are stable and identify the subject', () => {
  it('gives each engine its own id, so a second failure is a second alert', () => {
    const alerts = projectAlerts({
      engines: [
        engine({ engineId: 'a', health: 'down' }),
        engine({ engineId: 'b', health: 'down' }),
      ],
    });
    expect(alerts.map((a) => a.id)).toEqual([
      'engines:engine_offline:a',
      'engines:engine_offline:b',
    ]);
  });

  it('produces the same id for the same condition across two projections', () => {
    const input = { engines: [engine({ health: 'down' })] };
    expect(projectAlerts(input)[0].id).toBe(projectAlerts(input)[0].id);
  });

  it('separates "offline" from "never reached since startup"', () => {
    const [offline] = projectAlerts({ engines: [engine({ health: 'down' })] });
    const [unknown] = projectAlerts({ engines: [engine({ health: 'unknown' })] });
    expect(offline.severity).toBe('critical');
    expect(unknown.severity).toBe('warning');
    expect(offline.id).not.toBe(unknown.id);
  });
});

describe('operations alerts — only what the caller could read', () => {
  it('produces nothing at all from an empty input', () => {
    // The snapshot passes only PERMITTED domains in. A user without
    // `torrents.view` must not learn from an alert that torrents are failing.
    expect(projectAlerts({})).toEqual([]);
  });

  it('ignores a disabled indexer or provider', () => {
    // A disabled integration is not a fault; alerting on one would mean an
    // operator who turned something off gets told about it forever.
    expect(
      projectAlerts({
        indexers: [indexer({ enabled: false, health: 'down' })],
        providers: [provider({ enabled: false, health: 'down' })],
      }),
    ).toEqual([]);
    expect(
      projectAlerts({
        indexers: [indexer({ health: 'down' })],
        providers: [provider({ health: 'down' })],
      }),
    ).toHaveLength(2);
  });
});

describe('operations alerts — failed jobs', () => {
  /*
   * The bug this covers: the alert read the all-time `failed`, which never
   * decreases, so once anything had ever failed it was permanently red and
   * stopped carrying information. Live it read 13 against jobs three weeks old,
   * eleven of which were only "Interrupted by a service restart".
   */
  it('stays silent when the only failures are historical', () => {
    const alerts = projectAlerts({ jobs: jobs({ failed: 13, failedToday: 0 }) });
    expect(alerts.filter((a) => a.domain === 'jobs')).toEqual([]);
  });

  it('fires on failures that happened today', () => {
    const alerts = projectAlerts({ jobs: jobs({ failed: 13, failedToday: 3 }) });
    const a = alerts.find((x) => x.domain === 'jobs');
    expect(a?.severity).toBe('error');
    expect(a?.title).toContain('3 background job(s) failed today');
  });

  it('reports the all-time total as detail, not as the alarm', () => {
    const alerts = projectAlerts({ jobs: jobs({ failed: 13, failedToday: 1 }) });
    expect(alerts.find((x) => x.domain === 'jobs')?.detail).toContain('13');
  });
});

describe('operations alerts — ordering', () => {
  it('sorts most severe first, with a stable tiebreak', () => {
    const alerts = projectAlerts({
      system: system({ database: 'down' }),
      jobs: jobs({ failed: 2, failedToday: 2 }),
      storage: storage(STORAGE_WARNING_AT * 100),
    });
    expect(alerts.map((a) => a.severity)).toEqual(['critical', 'error', 'warning']);
  });

  it('does not mutate the array it is given', () => {
    const input = [
      { id: 'b', severity: 'warning' },
      { id: 'a', severity: 'critical' },
    ] as never[];
    const sorted = sortAlerts(input);
    expect(sorted).not.toBe(input);
    expect((input[0] as { id: string }).id).toBe('b');
  });
});
