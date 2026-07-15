/**
 * FFsubsync synchronization provider — audio-based automatic sync.
 *
 * INERT WHEN THE BINARY IS ABSENT. `ffsubsync` is not bundled (nor is ffmpeg), so
 * `isAvailable()` probes for it once and caches the answer, exactly like the
 * mediainfo probe's `hasBinary`. The workflow calls `isAvailable()` before
 * offering automatic sync; when it is false the module falls back to the manual
 * offset provider and records "sync skipped (ffsubsync not installed)". The real
 * invocation below runs only where an operator has installed the tool.
 */
import { Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  type SubtitleSynchronizationProvider,
  type SyncAnalysis,
  type SyncInput,
  type SyncResult,
} from './subtitle-sync-provider';

const exec = promisify(execFile);
const BIN = 'ffsubsync';
const RUN_TIMEOUT_MS = 120_000;

export class FfsubsyncProvider implements SubtitleSynchronizationProvider {
  readonly name = 'ffsubsync';
  private readonly logger = new Logger('FfsubsyncProvider');
  private available: boolean | null = null;
  private detectedVersion: string | null = null;

  get version(): string | null {
    return this.detectedVersion;
  }

  /** Probe for the binary once; the answer cannot change at runtime. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      const { stdout } = await exec(BIN, ['--version'], { timeout: 10_000 });
      this.detectedVersion = String(stdout).trim().split('\n')[0] || null;
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async analyze(_input: SyncInput): Promise<SyncAnalysis> {
    // ffsubsync produces its estimate only by running a full sync; nothing cheap
    // to report here.
    return { offsetMs: 0, driftFactor: 1, confidence: null };
  }

  async synchronize(input: SyncInput): Promise<SyncResult> {
    if (!(await this.isAvailable())) {
      throw new Error('ffsubsync is not installed');
    }
    const dir = await mkdtemp(path.join(tmpdir(), 'ut-subsync-'));
    const ext = input.format.replace(/^\./, '');
    const inPath = path.join(dir, `in.${ext}`);
    const outPath = path.join(dir, `out.${ext}`);
    try {
      await writeFile(inPath, input.content, 'utf8');
      // `ffsubsync <video> -i <sub> -o <out>` re-times the sub against the audio.
      await exec(BIN, [input.videoPath, '-i', inPath, '-o', outPath], {
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      });
      const content = await readFile(outPath, 'utf8');
      // ffsubsync does not expose a machine-readable offset; the re-timing lives
      // in the output. Magnitude is left unknown (0) rather than fabricated.
      return { content, offsetMs: 0, driftFactor: 1, confidence: null, method: 'audio' };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async estimateOffset(_input: SyncInput): Promise<number> {
    return 0;
  }

  async estimateDrift(_input: SyncInput): Promise<number> {
    return 1;
  }

  validateSync(result: SyncResult): boolean {
    return result.content.trim().length > 0;
  }
}
