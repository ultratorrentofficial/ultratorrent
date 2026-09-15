import type { MediaQualityProvenance, NormalizedMediaQuality } from '@ultratorrent/shared';

import { classifyResolution, resolutionOrdinal } from '../../media/cleanup/domain/resolution-class';

/**
 * Owned media → a normalized quality value object.
 *
 * Pure. Reads only columns the Media Manager already owns and draws no
 * conclusion about whether the result is *good* — that is the ladder's job.
 *
 * Two rules are inherited deliberately from the Library Cleanup Center's
 * `fact-assembly.ts`, which solved this problem first for policy evaluation:
 *
 *  - **`techSource === 'probe'` is the only definition of measured.** A
 *    filename guess is an unverified claim; the renamer strips those tokens
 *    and a rescan used to overwrite a real measurement with one.
 *  - **Resolution is classified from pixels, never from the stored label.**
 *    `classifyResolution` is measured-only and ordered; width is a first-class
 *    signal because a 2.39:1 scope encode of a 1080p master is 1920x800 and
 *    height alone would demote it.
 */

/** The subset of `MediaFile` this needs. Mirrors the cleanup domain's shape. */
export interface QualitySourceFile {
  width?: number | null;
  height?: number | null;
  resolution?: string | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  audioChannels?: number | null;
  bitrateKbps?: number | null;
  frameRate?: number | null;
  durationSec?: number | null;
  container?: string | null;
  videoBitDepth?: number | null;
  chromaSubsampling?: string | null;
  colorPrimaries?: string | null;
  colorTransfer?: string | null;
  colorSpace?: string | null;
  hdrFormat?: string | null;
  hdr?: string | null;
  techSource?: string | null;
  probedAt?: Date | null;
  probeError?: string | null;
  size?: bigint | number | null;
}

/** A probed row owns its technical facts; anything else is a filename guess. */
export function isProbeMeasured(file: QualitySourceFile): boolean {
  return file.techSource === 'probe' && file.probedAt != null;
}

/**
 * Whether the probe that ran actually extracted colour information.
 *
 * This exists because of a real property of this installation's data, not as a
 * theoretical nicety. An earlier probe pass populated width/height/bitrate but
 * predates the extraction of bit depth, chroma and HDR format — and the
 * backfill only ever selects rows `where probedAt is null`, so those rows are
 * never revisited. On such a row `hdrFormat` is null because nobody looked,
 * not because the file is SDR.
 *
 * mediainfo omits `HDR_Format` on genuinely SDR files, so absence IS the SDR
 * signal — but only when the same pass demonstrably read colour at all. Any
 * one extended colour field being present is that proof.
 */
function colourWasExtracted(file: QualitySourceFile): boolean {
  return (
    file.videoBitDepth != null ||
    file.chromaSubsampling != null ||
    file.colorTransfer != null ||
    file.colorPrimaries != null ||
    file.colorSpace != null ||
    file.hdrFormat != null ||
    file.hdr != null
  );
}

/**
 * HDR, with three honest outcomes.
 *
 * `true` measured and reported; `false` measured and reported none; `null`
 * nobody established it. Never `false` by absence alone — that is the exact
 * unknown-becomes-failure mistake this layer must not make.
 */
function hdrOf(file: QualitySourceFile, measured: boolean): boolean | null {
  if (!measured) return null;
  if (file.hdrFormat || file.hdr) return true;
  return colourWasExtracted(file) ? false : null;
}

const asNumber = (v: bigint | number | null | undefined): number | null => {
  if (v == null) return null;
  const n = typeof v === 'bigint' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};

/** Empty strings are absence, not a value. */
const str = (v: string | null | undefined): string | null => {
  const t = (v ?? '').trim();
  return t.length ? t : null;
};

/**
 * Normalize one file.
 *
 * `provenance` describes the file as a whole: a probed row is `measured`, a
 * row the scanner guessed from a filename is `inferred`, and a row nobody has
 * touched is `unknown`. Individual fields may still be null within a measured
 * file — that is the older-probe case above, and it is why every dimension
 * carries its own null rather than relying on this one flag.
 */
export function normalizeOwnedQuality(file: QualitySourceFile): NormalizedMediaQuality {
  const measured = isProbeMeasured(file);
  const provenance: MediaQualityProvenance = measured
    ? 'measured'
    : file.techSource === 'filename'
      ? 'inferred'
      : 'unknown';

  // Classified from pixels only. An inferred row's stored label is a guess and
  // must not masquerade as a measurement.
  const cls = measured ? classifyResolution(file.width, file.height) : 'unknown';
  const known = cls !== 'unknown';

  return {
    provenance,
    resolutionClass: known ? cls : null,
    resolutionOrdinal: known ? resolutionOrdinal(cls) : null,
    width: measured ? (file.width ?? null) : null,
    height: measured ? (file.height ?? null) : null,
    videoCodec: measured ? str(file.videoCodec) : null,
    videoBitDepth: measured ? (file.videoBitDepth ?? null) : null,
    hdr: hdrOf(file, measured),
    hdrFormat: measured ? str(file.hdrFormat) ?? str(file.hdr) : null,
    audioCodec: measured ? str(file.audioCodec) : null,
    audioChannels: measured ? (file.audioChannels ?? null) : null,
    bitrateKbps: measured ? (file.bitrateKbps ?? null) : null,
    frameRate: measured ? (file.frameRate ?? null) : null,
    durationSec: measured ? (file.durationSec ?? null) : null,
    container: measured ? str(file.container) : null,
    // Size is a filesystem fact, true regardless of whether anyone probed the
    // container — so it is reported even for an unmeasured row.
    sizeBytes: asNumber(file.size),
  };
}

/**
 * Pick the file that represents an item, and say how many were measured.
 *
 * `MediaFile` has no `isPrimary` column and no service owns the choice — every
 * consumer in the codebase reaches for `files[0]` independently. Rather than
 * inherit that arbitrariness, this prefers, in order: the highest measured
 * resolution, then the largest measured file, then any file at all. A quality
 * verdict must be deterministic, and "the best copy you own" is the only
 * defensible reading of "does my media meet my preference" when several
 * versions exist.
 */
export function representativeQuality(files: readonly QualitySourceFile[]): {
  quality: NormalizedMediaQuality | null;
  measuredCount: number;
  totalCount: number;
  /** True when several files exist and they are not all the same class. */
  multipleVersions: boolean;
} {
  const totalCount = files.length;
  if (!totalCount) {
    return { quality: null, measuredCount: 0, totalCount: 0, multipleVersions: false };
  }

  const normalized = files.map((f) => normalizeOwnedQuality(f));
  const measured = normalized.filter((q) => q.provenance === 'measured');
  const measuredCount = measured.length;

  const pool = measured.length ? measured : normalized;
  const best = [...pool].sort((a, b) => {
    const ra = a.resolutionOrdinal ?? -1;
    const rb = b.resolutionOrdinal ?? -1;
    if (ra !== rb) return rb - ra;
    return (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
  })[0];

  const classes = new Set(measured.map((q) => q.resolutionClass).filter(Boolean));
  return {
    quality: best ?? null,
    measuredCount,
    totalCount,
    multipleVersions: totalCount > 1 && classes.size > 1,
  };
}
