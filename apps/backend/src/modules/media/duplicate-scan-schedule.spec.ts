import { DuplicateScanScheduleService } from './duplicate-scan-schedule.service';

/**
 * Detection had no trigger of its own — it ran only when someone pressed Scan.
 * These pin the parts of the schedule that decide whether it runs at all.
 */
describe('DuplicateScanScheduleService', () => {
  const build = (stored: unknown, detect = jest.fn().mockResolvedValue(undefined)) => {
    const saved: Array<Record<string, unknown>> = [];
    // Stateful on purpose: set() writes and then re-reads to build its return
    // value, so a stub that always replays the original row would make a
    // successful write look like a rejected one.
    let current = stored;
    const prisma = {
      setting: {
        findUnique: jest.fn(() =>
          Promise.resolve(current === undefined ? null : { value: current }),
        ),
        upsert: jest.fn(({ update }: { update: { value: Record<string, unknown> } }) => {
          saved.push(update.value);
          current = update.value;
          return Promise.resolve({});
        }),
      },
    };
    const svc = new DuplicateScanScheduleService(prisma as never, { detect } as never);
    return { svc, saved, detect };
  };

  it('is off until switched on, so nothing starts running unasked', async () => {
    const { svc } = build(undefined);
    const cfg = await svc.get();
    expect(cfg.enabled).toBe(false);
    expect(cfg.intervalHours).toBe(24);
  });

  it('reports no next run while disabled — a schedule that will not fire promises nothing', async () => {
    const { svc } = build({ enabled: false, intervalHours: 24, lastRunAt: new Date().toISOString() });
    expect((await svc.get()).nextRunAt).toBeNull();
  });

  it('computes the next run from the last one', async () => {
    const last = new Date('2026-09-01T00:00:00Z').toISOString();
    const { svc } = build({ enabled: true, intervalHours: 6, lastRunAt: last });
    expect((await svc.get()).nextRunAt).toBe('2026-09-01T06:00:00.000Z');
  });

  it('rejects an interval it does not offer rather than storing it', async () => {
    const { svc } = build({});
    expect((await svc.set({ intervalHours: 3 })).intervalHours).toBe(24);
    expect((await svc.set({ intervalHours: 168 })).intervalHours).toBe(168);
  });

  it('does not scan while disabled', async () => {
    const { svc, detect } = build({ enabled: false, intervalHours: 24 });
    expect(await svc.tick()).toBe(false);
    expect(detect).not.toHaveBeenCalled();
  });

  it('does not scan before the interval has elapsed', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const { svc, detect } = build({ enabled: true, intervalHours: 24, lastRunAt: recent });
    expect(await svc.tick()).toBe(false);
    expect(detect).not.toHaveBeenCalled();
  });

  it('scans once the interval has passed, and records the run', async () => {
    const old = new Date(Date.now() - 48 * 3_600_000).toISOString();
    const { svc, detect, saved } = build({ enabled: true, intervalHours: 24, lastRunAt: old });
    expect(await svc.tick()).toBe(true);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(saved.at(-1)?.lastRunAt).toBeDefined();
  });

  it('runs the first time when enabled but never run', async () => {
    const { svc, detect } = build({ enabled: true, intervalHours: 24 });
    expect(await svc.tick()).toBe(true);
    expect(detect).toHaveBeenCalled();
  });

  /**
   * An unhandled rejection inside an @Interval kills the timer, which would end
   * the schedule silently — the exact failure this feature exists to prevent.
   */
  it('survives a failing scan instead of taking the timer down', async () => {
    const boom = jest.fn().mockRejectedValue(new Error('engine down'));
    const { svc } = build({ enabled: true, intervalHours: 24 }, boom);
    await expect(svc.tick()).resolves.toBe(false);
  });
});
