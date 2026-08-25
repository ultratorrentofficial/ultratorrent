import { BadRequestException } from '@nestjs/common';

import { GlobalBandwidthService, BANDWIDTH_SETTINGS_KEY } from './global-bandwidth.service';

/*
 * The global ceiling exists so an operator has one obvious place to cap
 * bandwidth, and the Activity Scheduler overrides it only where it is genuinely
 * governing an engine. The rule is per ENGINE, because engines are opted into
 * managed scheduling one at a time.
 */

type Provider = { engineId: string; setGlobalRateLimits?: (l: unknown) => Promise<void> };

/**
 * `rated` names the engines whose resolved policy states a rate.
 *
 * It replaces a list of policy ROWS, because a row cannot answer the question:
 * a library-scoped policy governs an engine only through the torrents in that
 * library, and the old scope comparison put library ids into a set of engine
 * ids where they could never match. The service now asks the plan — the same
 * object the reconciler acts on — so the harness supplies that instead.
 */
function build(opts: {
  ceiling?: { maxDownloadRateKbps: number | null; maxUploadRateKbps: number | null } | null;
  modes?: Record<string, string>;
  rated?: string[];
  previewThrows?: boolean;
  providers?: Provider[];
}) {
  const applied: Record<string, unknown> = {};
  const stored: { value?: unknown } = {};
  const reloadHooks: Array<() => unknown> = [];
  const providers: Provider[] = opts.providers ?? [
    { engineId: 'qb', setGlobalRateLimits: async (l) => { applied.qb = l; } },
  ];
  const service = new GlobalBandwidthService(
    {
      get: async () => (opts.ceiling === undefined ? null : opts.ceiling),
      set: async (_k: string, v: unknown) => { stored.value = v; },
    } as never,
    { list: () => providers, onReload: (cb: () => unknown) => { reloadHooks.push(cb); } } as never,
    { modes: async () => new Map(Object.entries(opts.modes ?? {})) } as never,
    {
      previewEngine: async (engineId: string) => {
        if (opts.previewThrows) throw new Error('engine offline');
        return {
          engineId,
          decisions: [{
            bandwidth: (opts.rated ?? []).includes(engineId)
              ? { sources: { maxUploadRateKbps: 'p1' }, maxDownloadRateKbps: null, maxUploadRateKbps: 25000 }
              : { sources: {}, maxDownloadRateKbps: null, maxUploadRateKbps: null },
          }],
        };
      },
    } as never,
    { record: async () => undefined } as never,
  );
  return { service, applied, stored, reloadHooks };
}

describe('the global bandwidth ceiling', () => {
  it('gives way to a LIBRARY-scoped policy, which the old scope check could not see', async () => {
    /*
     * The defect. Governance was derived from policy rows filtered to
     * `scopeType in (global, engine)`, comparing each row's `scopeId` against
     * engine ids — so a library-scoped policy contributed a LIBRARY id to a set
     * of engine ids, matched nothing, and the engine was reported ungoverned.
     * The ceiling was then written to an engine the scheduler was also writing
     * to, each undoing the other every sweep.
     */
    const { service, applied } = build({
      ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      modes: { qb: 'managed' },
      rated: ['qb'],
    });
    const plan = await service.apply();

    expect(plan[0].source).toBe('scheduler');
    expect(applied.qb).toBeUndefined();
  });

  it('defers to the scheduler when the plan cannot be read', async () => {
    // Fail towards the scheduler: writing the ceiling on a maybe is how two
    // writers start fighting over one value.
    const { service, applied } = build({
      ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      modes: { qb: 'managed' },
      previewThrows: true,
    });
    const plan = await service.apply();

    expect(plan[0].source).toBe('scheduler');
    expect(applied.qb).toBeUndefined();
  });

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
      rated: ['qb'],
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
      // Managed, but nothing states a rate — so the scheduler is not writing
      // this engine's limits and the ceiling is free to.
      rated: [],
    });
    const plan = await service.apply();

    expect(plan[0].source).toBe('settings');
    expect(applied.qb).toEqual({ downloadBytesPerSec: 625000, uploadBytesPerSec: null });
  });

  it('scopes a per-engine policy to that engine alone', async () => {
    const { service } = build({
      ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      modes: { qb: 'managed', rt: 'managed' },
      rated: ['qb'],
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

  /*
   * An engine added after the ceiling was saved must not run uncapped until
   * somebody presses Save again. A limit that is configured, shown on the
   * screen, and not in force is the worst state this feature has.
   */
  describe('engines that appear later', () => {
    it('applies the ceiling when the engine set changes', async () => {
      const { service, applied, reloadHooks } = build({
        ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
      });
      service.onModuleInit();
      expect(reloadHooks).toHaveLength(1);

      // A reload happens: the registry calls back.
      await reloadHooks[0]();
      expect(applied.qb).toEqual({ downloadBytesPerSec: 625000, uploadBytesPerSec: 125000 });
    });

    it('applies it once at boot as well, since the first reload precedes us', async () => {
      const { service, applied } = build({
        ceiling: { maxDownloadRateKbps: 2000, maxUploadRateKbps: null },
      });
      service.onModuleInit();
      await new Promise((r) => setTimeout(r, 0)); // the boot apply is fire-and-forget
      expect(applied.qb).toEqual({ downloadBytesPerSec: 250000, uploadBytesPerSec: null });
    });

    /*
     * An unreachable engine at boot must not stop the application starting.
     */
    it('never lets a failing engine escape as a startup error', async () => {
      const { service, reloadHooks } = build({
        ceiling: { maxDownloadRateKbps: 5000, maxUploadRateKbps: 1000 },
        providers: [
          {
            engineId: 'broken',
            setGlobalRateLimits: async () => {
              throw new Error('connection refused');
            },
          },
        ],
      });
      service.onModuleInit();
      await expect(reloadHooks[0]()).resolves.not.toThrow();
    });
  });

  it('stores under one settings key, read as a whole', () => {
    expect(BANDWIDTH_SETTINGS_KEY).toBe('torrents.bandwidth');
  });
});
