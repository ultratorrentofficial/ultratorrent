import { BadRequestException } from '@nestjs/common';

import { GlobalBandwidthService, BANDWIDTH_SETTINGS_KEY } from './global-bandwidth.service';

/*
 * The global ceiling exists so an operator has one obvious place to cap
 * bandwidth, and the Activity Scheduler overrides it only where it is genuinely
 * governing an engine. The rule is per ENGINE, because engines are opted into
 * managed scheduling one at a time.
 */

type Provider = { engineId: string; setGlobalRateLimits?: (l: unknown) => Promise<void> };

function build(opts: {
  ceiling?: { maxDownloadRateKbps: number | null; maxUploadRateKbps: number | null } | null;
  modes?: Record<string, string>;
  policies?: Array<{ scopeType: string; scopeId: string | null }>;
  providers?: Provider[];
}) {
  const applied: Record<string, unknown> = {};
  const stored: { value?: unknown } = {};
  const providers: Provider[] = opts.providers ?? [
    { engineId: 'qb', setGlobalRateLimits: async (l) => { applied.qb = l; } },
  ];
  const service = new GlobalBandwidthService(
    { torrentSchedulerPolicy: { findMany: async () => opts.policies ?? [] } } as never,
    {
      get: async () => (opts.ceiling === undefined ? null : opts.ceiling),
      set: async (_k: string, v: unknown) => { stored.value = v; },
    } as never,
    { list: () => providers } as never,
    { modes: async () => new Map(Object.entries(opts.modes ?? {})) } as never,
    { record: async () => undefined } as never,
  );
  return { service, applied, stored };
}

describe('the global bandwidth ceiling', () => {
  it('applies to an engine that never opted into scheduling', async () => {
    const { service, applied } = build({ ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 } });
    const plan = await service.apply();

    expect(plan[0].source).toBe('settings');
    // 5000 kbps -> bytes per second, which is what the engine takes.
    expect(applied.qb).toEqual({ downloadBytesPerSec: 625000, uploadBytesPerSec: 125000 });
  });

  it('gives way to the scheduler on an engine it actually governs', async () => {
    const { service, applied } = build({
      ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      modes: { qb: 'managed' },
      policies: [{ scopeType: 'global', scopeId: null }],
    });
    const plan = await service.apply();

    expect(plan[0].source).toBe('scheduler');
    expect(applied.qb).toBeUndefined();
  });

  /*
   * The case the whole feature turns on: an engine put into managed mode and
   * then left without a policy. Deferring to a scheduler that has no opinion
   * would leave it running uncapped, which is the "configured incorrectly"
   * outcome this is meant to catch.
   */
  it('falls back when an engine is managed but no policy covers it', async () => {
    const { service, applied } = build({
      ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: null },
      modes: { qb: 'managed' },
      policies: [],
    });
    const plan = await service.apply();

    expect(plan[0].source).toBe('settings');
    expect(applied.qb).toEqual({ downloadBytesPerSec: 625000, uploadBytesPerSec: null });
  });

  it('scopes a per-engine policy to that engine alone', async () => {
    const { service } = build({
      ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      modes: { qb: 'managed', rt: 'managed' },
      policies: [{ scopeType: 'engine', scopeId: 'qb' }],
      providers: [
        { engineId: 'qb', setGlobalRateLimits: async () => undefined },
        { engineId: 'rt', setGlobalRateLimits: async () => undefined },
      ],
    });
    const plan = await service.plan();

    expect(plan.find((e) => e.engineId === 'qb')?.source).toBe('scheduler');
    expect(plan.find((e) => e.engineId === 'rt')?.source).toBe('settings');
  });

  /*
   * Observe mode promises the scheduler makes no provider call whatsoever.
   * Writing a limit there would break that promise quietly, so it is reported
   * instead of done.
   */
  it('never writes to an observing engine', async () => {
    const { service, applied } = build({
      ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      modes: { qb: 'observe' },
    });
    const plan = await service.apply();

    expect(plan[0].source).toBe('observing');
    expect(applied.qb).toBeUndefined();
  });

  it('reports an engine that cannot take a global limit', async () => {
    const { service } = build({
      ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      providers: [{ engineId: 'legacy' }], // no setGlobalRateLimits
    });
    expect((await service.plan())[0].source).toBe('unsupported');
  });

  /*
   * An installation upgrading into this feature must not acquire limits it
   * never asked for, nor lose ones set in the engine's own UI.
   */
  it('touches nothing at all until somebody configures it', async () => {
    const { service, applied } = build({ ceiling: null });
    const plan = await service.apply();

    expect(plan[0].source).toBe('unconfigured');
    expect(applied.qb).toBeUndefined();
  });

  it('treats an empty limit as unlimited, and says so to the engine', async () => {
    const { service, applied } = build({ ceiling: { maxDownloadRateKbps: null, maxUploadRateKbps: null } });
    await service.apply();
    expect(applied.qb).toEqual({ downloadBytesPerSec: null, uploadBytesPerSec: null });
  });

  describe('validation', () => {
    const svc = () => build({}).service;

    it('refuses zero, which the engine would read as unlimited', async () => {
      await expect(svc().update({ maxDownloadRateKbps: 0 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses negative and fractional limits', async () => {
      await expect(svc().update({ maxUploadRateKbps: -1 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc().update({ maxUploadRateKbps: 12.5 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts null as an explicit "no limit"', async () => {
      await expect(svc().update({ maxDownloadRateKbps: null, maxUploadRateKbps: null })).resolves.toEqual({
        maxDownloadRateKbps: null,
        maxUploadRateKbps: null,
      });
    });
  });

  it('stores under one settings key, read as a whole', () => {
    expect(BANDWIDTH_SETTINGS_KEY).toBe('torrents.bandwidth');
  });
});
