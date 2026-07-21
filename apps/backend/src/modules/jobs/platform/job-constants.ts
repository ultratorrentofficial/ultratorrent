/**
 * The platform job engine's runtime tuning constants — the single source of truth.
 * The Jobs Center Settings surface reports these so it always reflects what the
 * runtime actually uses (no drift, no fabricated editable fields). They are
 * currently fixed; when a value becomes runtime-configurable, back it with a stored
 * setting the engine reads here.
 */

/** Minimum interval between persisted progress writes per job (WS is not throttled by this). */
export const PROGRESS_THROTTLE_MS = 1000;

/** A running job with no heartbeat past this is flagged stalled (advisory). */
export const STALL_THRESHOLD_MS = 5 * 60_000;

/** How often the stall scanner runs. */
export const STALL_SCAN_INTERVAL_MS = 30_000;

/** Default max attempts for a job type that doesn't override it. */
export const DEFAULT_MAX_ATTEMPTS = 1;
