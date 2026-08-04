import { SchedulerReconciliationService } from './scheduler-reconciliation.service';
import { SchedulerCapabilityService } from './scheduler-capability.service';
import type { EngineActivityPlan } from './domain/planner';

/**
 * Applying a bandwidth ceiling.
 *
 * Two conversions and one refusal carry the whole feature. Operators think in
 * kbps and engines take bytes per second; unlimited is `null` here and `0` in
 * both engines, and that convention stops at the provider boundary. And a
 * download/seed RESERVE cannot be expressed at all — the engines offer one
 * upload ceiling, not two — so it is reported rather than approximated, because
 * the obvious approximation (lowering the global ceiling) would throttle
 * downloads in order to protect seeding, which is the opposite of the ask.
 */
function planWith(bandwidth: Record<string, number | null>): EngineActivityPlan {
  return {
    engineId: 'e1',
    decisions: [{
      hash: 'a', engineId: 'e1', currentOccupancy: 'seed_active',
      desiredState: 'active', action: 'none', reasonCode: 'x', messageKey: 'x',
      score: 0, protectedFromPause: false,
      bandwidth: {
        maxDownloadRateKbps: null, maxUploadRateKbps: null,
        reserveDownloadPercent: null, reserveSeedPercent: null,
        ...bandwidth,
      },
    }],
    summary: { activeDownloads: 0, activeSeeds: 1, totalActive: 1, queuedDownloads: 0, queuedSeeds: 0 },
    limitations: [],
  };
}

const prisma = { torrentSchedulerState: { upsert: jest.fn(async (a: any) => a) } };
const svc = new SchedulerReconciliationService(prisma as never);
const noSleep = async () => undefined;

function provider(withGlobal = true) {
  const applied: any[] = [];
  const p: any = {
    pauseTorrent: jest.fn(), resumeTorrent: jest.fn(), getTorrent: jest.fn(async () => null),
  };
  if (withGlobal) {
    p.setGlobalRateLimits = jest.fn(async (l: any) => { applied.push(l); });
  }
  return { provider: p, applied };
}

describe('bandwidth', () => {
  it('converts kbps to bytes per second for the engine', () => {
    // 8000 kbps is 1 MB/s. Getting this backwards would throttle by a factor of
    // eight in whichever direction is wrong.
    const { provider: p, applied } = provider();
    return svc.apply(planWith({ maxUploadRateKbps: 8000 }), p, { sleep: noSleep }).then(() => {
      expect(applied[0].uploadBytesPerSec).toBe(1_000_000);
    });
  });

  it('passes null through as unlimited rather than zero', async () => {
    // `0` is the engines' word for unlimited; the interface's word is `null`,
    // and the translation belongs in the adapter, not here.
    const { provider: p, applied } = provider();
    await svc.apply(planWith({ maxDownloadRateKbps: null }), p, { sleep: noSleep });
    expect(applied[0].downloadBytesPerSec).toBeNull();
  });

  it('applies limits before pausing or resuming anything', async () => {
    // A torrent resumed into an uncapped engine transfers at full speed for as
    // long as the rest of the plan takes.
    const order: string[] = [];
    const p: any = {
      setGlobalRateLimits: jest.fn(async () => { order.push('limits'); }),
      pauseTorrent: jest.fn(async () => { order.push('pause'); }),
      resumeTorrent: jest.fn(),
      getTorrent: jest.fn(async () => null),
    };
    const plan = planWith({ maxUploadRateKbps: 1000 });
    plan.decisions.push({ ...plan.decisions[0], hash: 'b', action: 'pause' });

    await svc.apply(plan, p, { sleep: noSleep });
    expect(order).toEqual(['limits', 'pause']);
  });

  it('reports that a reserve split cannot be honoured, and still applies the cap', async () => {
    const { provider: p, applied } = provider();
    const out = await svc.apply(
      planWith({ maxUploadRateKbps: 5000, reserveSeedPercent: 20 }), p, { sleep: noSleep },
    );
    expect(out.limitations.map((l) => l.code)).toContain('bandwidth_reserve_unsupported');
    // The ceiling is still enforced — only the split is refused.
    expect(applied[0].uploadBytesPerSec).toBe(625_000);
  });

  it('reports an engine with no global limit support instead of failing', async () => {
    const { provider: p } = provider(false);
    const out = await svc.apply(planWith({ maxUploadRateKbps: 5000 }), p, { sleep: noSleep });
    expect(out.limitations.map((l) => l.code)).toContain('no_global_rate_limit');
    expect(out.failed).toBe(0);
  });

  it('records a refusal from the engine as a failure, without abandoning the plan', async () => {
    const p: any = {
      setGlobalRateLimits: jest.fn(async () => { throw new Error('403'); }),
      pauseTorrent: jest.fn(), resumeTorrent: jest.fn(), getTorrent: jest.fn(async () => null),
    };
    const out = await svc.apply(planWith({ maxUploadRateKbps: 5000 }), p, { sleep: noSleep });
    expect(out.failed).toBe(1);
    expect(out.failures[0].action).toBe('set_rate_limits');
  });

  it('does nothing at all when no policy sets a rate', async () => {
    const { provider: p, applied } = provider();
    await svc.apply(planWith({}), p, { sleep: noSleep });
    // Both null: still a legitimate instruction (unlimited), so it IS applied.
    expect(applied[0]).toEqual({ downloadBytesPerSec: null, uploadBytesPerSec: null });
  });
});

describe('global rate limit capability', () => {
  const caps = new SchedulerCapabilityService();

  it('is native on both shipped engines', () => {
    // The engines always supported it and already reported it through
    // getGlobalStats; only the setter was missing from the interface.
    for (const kind of ['qbittorrent', 'rtorrent'] as const) {
      expect(caps.for(kind).globalDownloadRateLimit).toBe('native');
      expect(caps.for(kind).globalUploadRateLimit).toBe('native');
    }
  });

  it('is still unsupported for an engine we have not characterised', () => {
    expect(caps.for('transmission' as never).globalUploadRateLimit).toBe('unsupported');
  });
});
