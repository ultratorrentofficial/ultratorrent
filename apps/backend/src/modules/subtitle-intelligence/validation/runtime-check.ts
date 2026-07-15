/**
 * Optional runtime cross-check — the deep validation pass that layers on top of
 * the pure structural validator. It compares a subtitle's last cue to the media's
 * MEASURED runtime (already probed by mediainfo and stored on `MediaFile`), so it
 * needs no new binary.
 *
 * The strong signal is a subtitle that ends AFTER the media does: a subtitle
 * legitimately ends before the film (credits), but one that runs past the end of
 * the file was almost certainly timed for a different, longer cut — a wrong-file
 * match the hash/score layers can miss.
 */
import type { ValidationIssue } from './subtitle-validator';

/** Grace beyond the media runtime before a subtitle is deemed too long. */
export const RUNTIME_OVERRUN_TOLERANCE_SEC = 30;

export interface RuntimeCheckResult {
  /** subtitle end (s) − media runtime (s); positive = subtitle runs longer. */
  runtimeDeltaSec: number | null;
  issue: ValidationIssue | null;
}

/**
 * Cross-check a subtitle's end timestamp against the media runtime. Returns the
 * delta and an issue when the subtitle overruns the media by more than the
 * tolerance. Null inputs → no check (delta null, no issue). Pure.
 */
export function runtimeCrossCheck(
  subtitleEndMs: number | null,
  mediaRuntimeSec: number | null | undefined,
  toleranceSec = RUNTIME_OVERRUN_TOLERANCE_SEC,
): RuntimeCheckResult {
  if (subtitleEndMs == null || !mediaRuntimeSec || mediaRuntimeSec <= 0) {
    return { runtimeDeltaSec: null, issue: null };
  }
  const runtimeDeltaSec = Math.round(subtitleEndMs / 1000 - mediaRuntimeSec);
  if (runtimeDeltaSec > toleranceSec) {
    return {
      runtimeDeltaSec,
      issue: {
        code: 'runtime_overrun',
        message: `Subtitle ends ${runtimeDeltaSec}s after the media runtime — likely timed for a different cut.`,
        severity: 'error',
      },
    };
  }
  return { runtimeDeltaSec, issue: null };
}
