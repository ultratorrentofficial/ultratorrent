/**
 * Subtitle synchronization abstraction. The workflow depends only on this
 * interface, so FFsubsync (audio-based), a manual offset, Alass, or a future AI
 * synchronizer all drop in the same way.
 *
 * Two providers ship in this phase: a pure manual-offset engine (always
 * available) and an FFsubsync provider that stays INERT when the `ffsubsync`
 * binary is absent — exactly how the metadata TVDB provider ships without a key
 * and the mediainfo probe degrades without its binary. `isAvailable()` is what the
 * service checks before offering automatic sync.
 */

export interface SyncInput {
  /** The video path (audio reference for automatic sync). May be unused by offset. */
  videoPath: string;
  /** The subtitle text to re-time. */
  content: string;
  /** Subtitle format without a dot: srt | vtt | ass | ssa | sub. */
  format: string;
  /** Manual offset (ms, may be negative) — used by the offset provider. */
  offsetMs?: number;
  /** Linear time-scale factor (1 = none) — used by the offset provider for drift. */
  driftFactor?: number;
}

export interface SyncAnalysis {
  /** Estimated constant offset in ms (may be negative). */
  offsetMs: number;
  /** Estimated linear drift factor (1 = none). */
  driftFactor: number;
  /** 0..1 confidence, when the provider can estimate one. */
  confidence: number | null;
}

export interface SyncResult {
  /** The re-timed subtitle text. */
  content: string;
  offsetMs: number;
  driftFactor: number;
  confidence: number | null;
  /** `audio` (ffsubsync/alass) or `offset` (manual). */
  method: 'audio' | 'offset';
  /** Matched speech-region summary, when the provider reports one. */
  matchedRegions?: unknown;
}

export interface SubtitleSynchronizationProvider {
  readonly name: string;
  /** Tool/provider version string, when known. */
  readonly version: string | null;

  /** True when this provider can actually run (e.g. its binary is installed). */
  isAvailable(): Promise<boolean>;

  /** Estimate offset/drift without writing output. Never throws (returns nulls). */
  analyze(input: SyncInput): Promise<SyncAnalysis>;
  /** Produce the re-timed subtitle. Throws on hard failure. */
  synchronize(input: SyncInput): Promise<SyncResult>;

  estimateOffset(input: SyncInput): Promise<number>;
  estimateDrift(input: SyncInput): Promise<number>;
  /** Sanity-check a produced sync (e.g. offset within a believable bound). */
  validateSync(result: SyncResult): boolean;
}

/** An offset this large almost certainly means a mismatched file, not drift. */
export const MAX_BELIEVABLE_OFFSET_MS = 5 * 60_000;
