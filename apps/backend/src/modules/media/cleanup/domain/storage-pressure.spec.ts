import {
  BREAKER, breakerIsOpen, bytesToTarget, cronIsDue, isUsableReading,
  pressureRunShouldStop, recordRunOutcome, shouldRelievePressure,
  type BreakerState, type FreeSpaceReading,
} from './storage-pressure';

const TB = 1024 ** 4;
const reading = (freePercent: number, totalBytes = TB): FreeSpaceReading => ({
  totalBytes,
  availableBytes: (freePercent / 100) * totalBytes,
  freePercent,
});

describe('a reading we cannot trust never triggers a deletion', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    // An unmounted path can statfs to something with no blocks at all; reading
    // that as "0% free" would start deleting on a disk we cannot even see.
    ['a zero-byte filesystem', { totalBytes: 0, availableBytes: 0, freePercent: 0 }],
    ['a negative available count', { totalBytes: TB, availableBytes: -1, freePercent: 0 }],
    ['NaN', { totalBytes: NaN, availableBytes: NaN, freePercent: NaN }],
  ])('refuses to fire on %s', (_label, r) => {
    expect(isUsableReading(r as never)).toBe(false);
    const d = shouldRelievePressure(r as never, { triggerBelowPercent: 10 });
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/could not be read/);
  });
});

describe('the trigger', () => {
  it('fires below the threshold', () => {
    const d = shouldRelievePressure(reading(5), { triggerBelowPercent: 10, stopAtPercent: 20 });
    expect(d.fire).toBe(true);
  });

  it('does not fire at or above the threshold', () => {
    expect(shouldRelievePressure(reading(10), { triggerBelowPercent: 10 }).fire).toBe(false);
    expect(shouldRelievePressure(reading(50), { triggerBelowPercent: 10 }).fire).toBe(false);
  });

  // The document validator refuses this shape, but a version written before that
  // rule still exists in the database, so the runtime refuses it too.
  it('refuses a stop target that can never be reached', () => {
    const d = shouldRelievePressure(reading(5), { triggerBelowPercent: 10, stopAtPercent: 10 });
    expect(d.fire).toBe(false);
    expect(d.reason).toMatch(/never be reached/);
  });

  it('refuses a missing or nonsensical trigger', () => {
    expect(shouldRelievePressure(reading(1), { triggerBelowPercent: 0 }).fire).toBe(false);
    expect(shouldRelievePressure(reading(1), { triggerBelowPercent: NaN }).fire).toBe(false);
  });

  it('says how much must be reclaimed to reach the target', () => {
    const d = shouldRelievePressure(reading(5), { triggerBelowPercent: 10, stopAtPercent: 20 });
    // 20% of 1 TiB wanted, 5% available → 15% of a TiB to reclaim.
    expect(d.fire && d.targetBytes).toBe(Math.ceil(0.15 * TB));
  });

  it('asks for nothing when the target is already met', () => {
    expect(bytesToTarget(reading(30), 20)).toBe(0);
  });

  it('has no target when the policy sets none', () => {
    const d = shouldRelievePressure(reading(5), { triggerBelowPercent: 10 });
    expect(d.fire && d.targetBytes).toBeNull();
  });
});

describe('a pressure run stops at the first limit it meets', () => {
  const base = { reclaimedBytes: 0, itemCount: 0, startedAt: 0, now: 0, targetBytes: null, config: {} as never };

  it('stops when the target is reached', () => {
    const r = pressureRunShouldStop({ ...base, reclaimedBytes: 100, targetBytes: 100,
      config: { triggerBelowPercent: 10 } });
    expect(r).toEqual({ stop: true, reason: 'target_reached' });
  });

  it('stops at the item cap', () => {
    const r = pressureRunShouldStop({ ...base, itemCount: 50,
      config: { triggerBelowPercent: 10, maxItemsPerRun: 50 } });
    expect(r.reason).toBe('max_items');
  });

  it('stops at the byte cap', () => {
    const r = pressureRunShouldStop({ ...base, reclaimedBytes: 999,
      config: { triggerBelowPercent: 10, maxReclaimBytesPerRun: 500 } });
    expect(r.reason).toBe('max_bytes');
  });

  it('stops at the runtime cap', () => {
    const r = pressureRunShouldStop({ ...base, startedAt: 0, now: 61_000,
      config: { triggerBelowPercent: 10, maxRuntimeSeconds: 60 } });
    expect(r.reason).toBe('max_runtime');
  });

  it('keeps going while every limit is unmet', () => {
    const r = pressureRunShouldStop({ ...base, reclaimedBytes: 10, itemCount: 1, targetBytes: 1000,
      config: { triggerBelowPercent: 10, maxItemsPerRun: 100, maxRuntimeSeconds: 3600 } });
    expect(r.stop).toBe(false);
  });

  // An uncapped run is exactly what the validator refuses for an automatic policy,
  // but the primitive must still behave predictably if handed one.
  it('runs on when nothing bounds it', () => {
    expect(pressureRunShouldStop({ ...base, config: { triggerBelowPercent: 10 } }).stop).toBe(false);
  });
});

describe('the circuit breaker stops the automatic path, not the human one', () => {
  const closed: BreakerState = { consecutiveFailures: 0, openedAt: null };

  it('stays closed below the threshold', () => {
    let s: BreakerState = closed;
    for (let i = 1; i < BREAKER.failureThreshold; i += 1) s = recordRunOutcome(s, false, 1000);
    expect(breakerIsOpen(s, 1000)).toBe(false);
  });

  it('opens on the threshold failure', () => {
    let s: BreakerState = closed;
    for (let i = 0; i < BREAKER.failureThreshold; i += 1) s = recordRunOutcome(s, false, 1000);
    expect(breakerIsOpen(s, 1000)).toBe(true);
  });

  it('closes again after the cooldown', () => {
    let s: BreakerState = closed;
    for (let i = 0; i < BREAKER.failureThreshold; i += 1) s = recordRunOutcome(s, false, 1000);
    expect(breakerIsOpen(s, 1000 + BREAKER.cooldownMs)).toBe(false);
  });

  it('one success clears the count outright', () => {
    let s: BreakerState = recordRunOutcome(closed, false, 1);
    s = recordRunOutcome(s, false, 2);
    s = recordRunOutcome(s, true, 3);
    expect(s).toEqual({ consecutiveFailures: 0, openedAt: null });
  });
});

describe('cron due-ness', () => {
  const now = new Date('2026-07-22T04:00:00Z');
  const threeAm = new Date('2026-07-22T03:00:00Z');

  it('is due when the last run predates the most recent firing', () => {
    expect(cronIsDue({ previousFiring: threeAm, lastRunAt: new Date('2026-07-21T03:00:00Z'), now })).toBe(true);
  });

  // A restart must not replay a backlog.
  it('is not due when it already ran for that firing', () => {
    expect(cronIsDue({ previousFiring: threeAm, lastRunAt: new Date('2026-07-22T03:00:05Z'), now })).toBe(false);
  });

  it('is due on its first elapsed firing when it has never run', () => {
    expect(cronIsDue({ previousFiring: threeAm, lastRunAt: null, now })).toBe(true);
  });

  // Enabling a nightly policy at noon must not run it at noon.
  it('is not due when no firing has elapsed yet', () => {
    expect(cronIsDue({ previousFiring: null, lastRunAt: null, now })).toBe(false);
  });

  it('ignores a firing in the future (a clock that moved backwards)', () => {
    expect(cronIsDue({
      previousFiring: new Date('2026-07-23T03:00:00Z'), lastRunAt: null, now,
    })).toBe(false);
  });
});
