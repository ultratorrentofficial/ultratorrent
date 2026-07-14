import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** How long a single probe may take before we give up on the file. */
const PROBE_TIMEOUT_MS = 20_000;
/** mediainfo's JSON can be large on multi-track files; cap what we buffer. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

/**
 * What the container actually says — as opposed to what the filename claims.
 * Every field is optional: a probe that reads a track but not its bitrate should
 * still record everything else it learned.
 */
export interface ProbedTech {
  container?: string;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  /** Overall stream bitrate in kbps (video+audio+overhead), the useful figure. */
  bitrateKbps?: number;
  durationSec?: number;
  audioChannels?: number;
  frameRate?: number;
  hdr?: string;
  /** Derived from `height`, so it means the real thing, not a filename token. */
  resolution?: string;
}

const num = (v: unknown): number | undefined => {
  if (v == null) return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Height → the resolution label the rest of the app speaks (`1080p`, `720p`…).
 *
 * Banded, not exact, because real files are rarely the textbook height: a 1080p
 * release is usually letterboxed to 1920x804, and the SD rips in a typical library
 * come in at 720x404 or 852x480. Matching on `height === 1080` would label almost
 * everything `unknown`. The bands are keyed off the LOWER bound of each tier so a
 * cropped frame still reports the tier it was mastered at.
 */
export function resolutionFromHeight(height?: number, width?: number): string | undefined {
  const h = height ?? 0;
  const w = width ?? 0;
  if (!h && !w) return undefined;
  // Use width as a fallback signal — a 2.39:1 scope frame is short but wide.
  if (h >= 1700 || w >= 3200) return '2160p';
  if (h >= 850 || w >= 1800) return '1080p';
  if (h >= 620 || w >= 1200) return '720p';
  if (h >= 380 || w >= 700) return '480p';
  return 'sd';
}

/** mediainfo codec names → the tokens the match-engine and profiles already use. */
function normalizeVideoCodec(format?: string): string | undefined {
  if (!format) return undefined;
  const f = format.toLowerCase();
  if (f.includes('hevc') || f.includes('h.265') || f.includes('h265')) return 'x265';
  if (f.includes('avc') || f.includes('h.264') || f.includes('h264')) return 'x264';
  if (f.includes('av1')) return 'av1';
  if (f.includes('vp9')) return 'vp9';
  if (f.includes('mpeg-4 visual') || f.includes('xvid') || f.includes('divx')) return 'xvid';
  if (f.includes('mpeg')) return 'mpeg';
  return f;
}

/**
 * mediainfo `--Output=JSON` → {@link ProbedTech}. PURE: no IO, no binary needed, so
 * the mapping is unit-tested against fixture JSON rather than against a machine that
 * happens to have mediainfo installed.
 */
export function parseMediaInfo(json: unknown): ProbedTech {
  const root = (json as any)?.media;
  const tracks: any[] = Array.isArray(root?.track) ? root.track : [];
  if (!tracks.length) return {};

  const general = tracks.find((t) => t['@type'] === 'General') ?? {};
  const video = tracks.find((t) => t['@type'] === 'Video') ?? {};
  const audio = tracks.find((t) => t['@type'] === 'Audio') ?? {};

  const width = num(video.Width);
  const height = num(video.Height);

  // Prefer the container's overall bitrate: a per-track video bitrate omits audio,
  // and plenty of files carry one but not the other. Fall back to the video track.
  const bits = num(general.OverallBitRate) ?? num(video.BitRate);

  const out: ProbedTech = {
    container: general.Format ? String(general.Format).toLowerCase() : undefined,
    videoCodec: normalizeVideoCodec(video.Format),
    audioCodec: audio.Format ? String(audio.Format).toLowerCase() : undefined,
    width,
    height,
    bitrateKbps: bits ? Math.round(bits / 1000) : undefined,
    durationSec: num(general.Duration) ? Math.round(num(general.Duration)!) : undefined,
    audioChannels: num(audio.Channels),
    frameRate: num(video.FrameRate),
    // HDR_Format is absent on SDR files, which is exactly the signal we want.
    hdr: video.HDR_Format ? String(video.HDR_Format).split('/')[0].trim() : undefined,
    resolution: resolutionFromHeight(height, width),
  };
  // Drop undefined keys so a caller can spread this over a row without nulling
  // columns the probe simply didn't learn.
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined)) as ProbedTech;
}

/**
 * Reads a media file's REAL technical metadata by parsing its container header.
 *
 * The library's existing codec/resolution columns are guessed from the filename, and
 * the renamer strips those tokens — so on a renamed library they are mostly null and
 * anything that depends on them (duplicate resolution, upgrade decisions) is flying
 * blind. This reads the file instead.
 *
 * `mediainfo` rather than ffmpeg: it is the same library tinyMediaManager uses, it
 * emits JSON directly, and it costs **18 MB** in the image where ffmpeg costs 440 MB.
 * A probe reads the header, not the stream — measured at 110–190 ms per file on a NAS.
 */
@Injectable()
export class MediaProbeService {
  private readonly logger = new Logger(MediaProbeService.name);
  private available: boolean | null = null;

  /** Is the mediainfo binary present? Cached — the answer cannot change at runtime. */
  async isAvailable(): Promise<boolean> {
    if (this.available !== null) return this.available;
    try {
      await exec('mediainfo', ['--Version'], { timeout: 5_000 });
      this.available = true;
    } catch {
      this.available = false;
      this.logger.warn('mediainfo is not installed — media files cannot be probed.');
    }
    return this.available;
  }

  /**
   * Probe one file. Throws on an unreadable/corrupt file so the caller can record
   * WHY and stop retrying it; returns `{}` only when the container held no tracks.
   */
  async probe(filePath: string): Promise<ProbedTech> {
    const { stdout } = await exec('mediainfo', ['--Output=JSON', filePath], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      throw new Error('mediainfo returned unparseable JSON');
    }
    return parseMediaInfo(json);
  }
}
