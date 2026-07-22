/**
 * Storage pressure and scheduling decisions — pure, so "should this fire?" is
 * tested directly rather than by moving a clock or filling a disk.
 *
 * The governing idea: automatic cleanup is the most dangerous thing this subsystem
 * does, so every answer here is the CONSERVATIVE one when an input is missing. A
 * free-space reading we could not take is not "the disk is full", it is "we do not
 * know", and not knowing is never a reason to start deleting.
 */

export interface FreeSpaceReading {
  /** Bytes actually usable by this process (statfs `bavail`, not `bfree`). */
  availableBytes: number;
  totalBytes: number;
  freePercent: number;
}

export interface StoragePressureConfig {
  /** Fire when free space drops below this percentage. */
  triggerBelowPercent: number;
  /** Stop once free space reaches this. Must exceed the trigger to be reachable. */
  stopAtPercent?: number;
  maxItemsPerRun?: number;
  maxReclaimBytesPerRun?: number;
  maxRuntimeSeconds?: number;
}

export type PressureDecision =
  | { fire: true; targetBytes: number | null; reason: string }
  | { fire: false; reason: string };

/**
 * A reading is only usable if it is internally coherent. A zero-byte total means
 * statfs answered for something that is not a real filesystem (an unmounted path
 * reads as its mountpoint's parent, or as nothing at all), and treating that as
 * "0% free" would trigger a cleanup on a disk we cannot even see.
 */
export function isUsableReading(reading: FreeSpaceReading | null | undefined): reading is FreeSpaceReading {
  if (!reading) return false;
  if (!Number.isFinite(reading.totalBytes) || reading.totalBytes <= 0) return false;
  if (!Number.isFinite(reading.availableBytes) || reading.availableBytes < 0) return false;
  return Number.isFinite(reading.freePercent);
}

/** How many bytes must be reclaimed to reach the stop target, or null if none is set. */
export function bytesToTarget(reading: FreeSpaceReading, stopAtPercent?: number): number | null {
  if (stopAtPercent == null) return null;
  const targetBytes = (stopAtPercent / 100) * reading.totalBytes;
  const deficit = targetBytes - reading.availableBytes;
  return deficit > 0 ? Math.ceil(deficit) : 0;
}

export function shouldRelievePressure(
  reading: FreeSpaceReading | null | undefined,
  config: StoragePressureConfig,
): PressureDecision {
  // Not knowing is never a reason to delete.
  if (!isUsableReading(reading)) {
    return { fire: false, reason: 'free space could not be read' };
  }
  if (!Number.isFinite(config.triggerBelowPercent) || config.triggerBelowPercent <= 0) {
    return { fire: false, reason: 'no usable trigger threshold' };
  }
  // A stop target at or below the trigger can never be reached, so the run would
  // delete until it hit a cap. The validator refuses this shape; refuse it here too,
  // because a document written before that rule still exists in the database.
  if (config.stopAtPercent != null && config.stopAtPercent <= config.triggerBelowPercent) {
    return { fire: false, reason: 'stop target is not above the trigger, so it can never be reached' };
  }
  if (reading.freePercent >= config.triggerBelowPercent) {
    return { fire: false, reason: `free space is ${reading.freePercent.toFixed(1)}%, above the ${config.triggerBelowPercent}% trigger` };
  }

  const target = bytesToTarget(reading, config.stopAtPercent);
  return {
    fire: true,
    targetBytes: target,
    reason: `free space is ${reading.freePercent.toFixed(1)}%, below the ${config.triggerBelowPercent}% trigger`,
  };
}

/** Has this run met its stop target, or hit one of its caps? */
export function pressureRunShouldStop(input: {
  reclaimedBytes: number;
  itemCount: number;
  startedAt: number;
  now: number;
  targetBytes: number | null;
  config: StoragePressureConfig;
}): { stop: boolean; reason?: 'target_reached' | 'max_items' | 'max_bytes' | 'max_runtime' } {
  const { config } = input;
  if (input.targetBytes != null && input.reclaimedBytes >= input.targetBytes) {
    return { stop: true, reason: 'target_reached' };
  }
  if (config.maxItemsPerRun != null && input.itemCount >= config.maxItemsPerRun) {
    return { stop: true, reason: 'max_items' };
  }
  if (config.maxReclaimBytesPerRun != null && input.reclaimedBytes >= config.maxReclaimBytesPerRun) {
    return { stop: true, reason: 'max_bytes' };
  }
  if (config.maxRuntimeSeconds != null &&
      input.now - input.startedAt >= config.maxRuntimeSeconds * 1000) {
    return { stop: true, reason: 'max_runtime' };
  }
  return { stop: false };
}

// ── circuit breaker ──────────────────────────────────────────────────────────
export interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
}

export const BREAKER = {
  /** Consecutive failed runs before automatic scheduling stops. */
  failureThreshold: 3,
  /** How long it stays open before one probe is allowed through. */
  cooldownMs: 60 * 60 * 1000,
} as const;

/**
 * A breaker exists because automatic cleanup that keeps failing is either
 * misconfigured or acting on a broken filesystem, and retrying on a schedule turns
 * one bad night into a thousand failed operations nobody reads. It stops the
 * AUTOMATIC path only — a human can always run a policy by hand.
 */
export function breakerIsOpen(state: BreakerState, now: number): boolean {
  if (state.openedAt == null) return false;
  return now - state.openedAt < BREAKER.cooldownMs;
}

export function recordRunOutcome(state: BreakerState, ok: boolean, now: number): BreakerState {
  if (ok) return { consecutiveFailures: 0, openedAt: null };
  const failures = state.consecutiveFailures + 1;
  return {
    consecutiveFailures: failures,
    openedAt: failures >= BREAKER.failureThreshold ? now : state.openedAt,
  };
}

// ── cron ─────────────────────────────────────────────────────────────────────
/**
 * Is a cron schedule due, given when it last ran?
 *
 * Answered by asking for the most recent firing at or before `now` and comparing
 * with `lastRunAt`, rather than by keeping a next-fire timestamp: a restart, a
 * clock change or a paused container must not replay a backlog, and must not skip
 * the current window either. A policy that has never run is due at its first
 * elapsed firing, not immediately — otherwise enabling a nightly policy at noon
 * runs it at noon.
 */
export function cronIsDue(input: {
  previousFiring: Date | null;
  lastRunAt: Date | null;
  now: Date;
}): boolean {
  if (!input.previousFiring) return false; // no firing has elapsed yet
  if (input.previousFiring.getTime() > input.now.getTime()) return false;
  if (!input.lastRunAt) return true;
  return input.lastRunAt.getTime() < input.previousFiring.getTime();
}
