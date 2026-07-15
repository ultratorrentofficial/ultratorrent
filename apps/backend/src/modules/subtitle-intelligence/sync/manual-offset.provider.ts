/**
 * Manual-offset synchronization — a pure, always-available provider that shifts
 * a subtitle by an operator-supplied offset (and optional linear drift). No audio
 * analysis, no binary: this is what lets a user fix timing even when no automatic
 * synchronizer is installed.
 */
import {
  MAX_BELIEVABLE_OFFSET_MS,
  type SubtitleSynchronizationProvider,
  type SyncAnalysis,
  type SyncInput,
  type SyncResult,
} from './subtitle-sync-provider';
import { shiftTimestamps } from './retime';

export class ManualOffsetProvider implements SubtitleSynchronizationProvider {
  readonly name = 'manual_offset';
  readonly version = '1';

  async isAvailable(): Promise<boolean> {
    return true; // pure arithmetic — always runnable
  }

  async analyze(input: SyncInput): Promise<SyncAnalysis> {
    return { offsetMs: input.offsetMs ?? 0, driftFactor: input.driftFactor ?? 1, confidence: null };
  }

  async synchronize(input: SyncInput): Promise<SyncResult> {
    const offsetMs = Math.round(input.offsetMs ?? 0);
    const driftFactor = input.driftFactor ?? 1;
    const content = shiftTimestamps(input.content, input.format, offsetMs, driftFactor);
    return { content, offsetMs, driftFactor, confidence: null, method: 'offset' };
  }

  async estimateOffset(input: SyncInput): Promise<number> {
    return Math.round(input.offsetMs ?? 0);
  }

  async estimateDrift(input: SyncInput): Promise<number> {
    return input.driftFactor ?? 1;
  }

  validateSync(result: SyncResult): boolean {
    return Math.abs(result.offsetMs) <= MAX_BELIEVABLE_OFFSET_MS && result.driftFactor > 0;
  }
}
