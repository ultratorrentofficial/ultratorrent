import { BadRequestException, Injectable } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ConflictFileInfo,
  ConflictKind,
  ConflictResolution,
  MoveConflict,
  MoveConflictReport,
  QualityVerdict,
} from '@ultratorrent/shared';
import { parseTorrentName, releaseIdentity } from '../rss/torrent-name-parser';
import { compareQuality } from '../media-acquisition/quality-compare';
import { FilePathService } from './file-path.service';

/**
 * Answers "what is already in the destination, and how does it compare?" for a
 * planned move/copy — before anything is touched.
 *
 * Read-only by construction, like `cleanup-preview` and `inspect`: it reports and
 * never asserts, because every outcome here is the operator's call. The three
 * conflict kinds it distinguishes drive genuinely different decisions:
 *
 * - `identical`    — the bytes are already filed. The source is redundant.
 * - `same_episode` — the episode is filed, as a *different release*. Which one to
 *                    keep is a judgement call, so we hand over the evidence.
 * - `name_clash`   — same filename, unparseable or unrelated content. Nothing can
 *                    be inferred; only the operator knows.
 *
 * Episode identity comes from `releaseIdentity` — the same quality-independent key
 * (`ep:<title>:<season>:<episode>`) the RSS upgrade path uses, so "the same episode"
 * means here exactly what it means there. It returns null for anything it cannot
 * identify confidently, and that null is load-bearing: an unidentified file falls
 * back to name-clash rather than risking a claim that two unrelated files are the
 * same episode.
 */

/**
 * Bytes read from each end when comparing contents.
 *
 * Full-file sha256 is the only *proof* of identity, but these are multi-hundred-MB
 * media files on a NAS and the operator is waiting on a dialog. A re-encode or a
 * different release differs in both the container header and the trailing frames,
 * so head+tail over equal-sized files is decisive in practice. `identityBasis` on
 * the wire states this, so the UI can say what was actually checked rather than
 * implying a full comparison.
 */
const PARTIAL_HASH_WINDOW = 8 * 1024 * 1024;

interface DestEntry {
  abs: string;
  name: string;
  size: number;
  modifiedAt: Date | null;
  identity: string | null;
}

@Injectable()
export class MoveConflictService {
  constructor(private readonly paths: FilePathService) {}

  private get safety() {
    return this.paths.safety;
  }

  /**
   * Compare every source against the destination directory.
   *
   * `sources` and `destination` are root-relative; the caller must have already
   * resolved them through {@link PathSafety}.
   */
  async analyze(sources: string[], destination: string): Promise<MoveConflictReport> {
    const destDir = this.safety.resolveLogical(destination);
    const destStat = await stat(destDir).catch(() => null);
    if (!destStat?.isDirectory()) {
      throw new BadRequestException('Destination is not a directory');
    }

    const entries = await this.readDestination(destDir);
    const conflicts: MoveConflict[] = [];
    const clean: string[] = [];

    for (const rel of sources) {
      const src = await this.safety.resolveExisting(rel);
      const info = await stat(src).catch(() => null);
      // A directory has no release identity and no content comparison worth the
      // I/O; leave it to the existing exists/overwrite handling.
      if (!info || info.isDirectory()) {
        clean.push(rel);
        continue;
      }

      const name = path.basename(src);
      const identity = releaseIdentity(name);
      // A file already at the exact destination path is the obvious collision;
      // failing that, the same episode filed under a different release name.
      const target =
        entries.find((e) => e.abs === path.join(destDir, name)) ??
        (identity ? entries.find((e) => e.identity === identity) : undefined);

      if (!target || target.abs === src) {
        clean.push(rel);
        continue;
      }

      const identical = info.size === target.size && (await this.sameContent(src, target.abs));
      const kind: ConflictKind = identical
        ? 'identical'
        : identity && target.identity === identity
          ? 'same_episode'
          : 'name_clash';

      const sourceInfo = this.describe(src, name, info.size, info.mtime);
      const targetInfo = this.describe(target.abs, target.name, target.size, target.modifiedAt);
      const { verdict, verdictReasons } = kind === 'identical'
        ? { verdict: 'equivalent' as QualityVerdict, verdictReasons: [] }
        : this.judge(name, target.name);

      conflicts.push({
        source: sourceInfo,
        target: targetInfo,
        kind,
        ...(identical ? { identityBasis: 'size+partial-hash' as const } : {}),
        verdict,
        verdictReasons,
        recommended: this.recommend(kind, verdict),
        allowed: this.allowedFor(kind),
      });
    }

    return { destination: this.safety.toRelative(destDir), conflicts, clean };
  }

  /** Files in the destination, each with its episode identity precomputed. */
  private async readDestination(destDir: string): Promise<DestEntry[]> {
    const dirents = await readdir(destDir, { withFileTypes: true }).catch(() => []);
    const out: DestEntry[] = [];
    for (const d of dirents) {
      if (!d.isFile()) continue;
      const abs = path.join(destDir, d.name);
      const info = await stat(abs).catch(() => null);
      if (!info) continue;
      out.push({
        abs,
        name: d.name,
        size: info.size,
        modifiedAt: info.mtime,
        identity: releaseIdentity(d.name),
      });
    }
    return out;
  }

  /**
   * True when two equal-sized files match at both ends. Callers must compare
   * sizes first — this only reads.
   */
  private async sameContent(a: string, b: string): Promise<boolean> {
    const [ha, hb] = await Promise.all([this.partialHash(a), this.partialHash(b)]);
    // A read error yields a path-tagged sentinel, so a failure can never be
    // mistaken for a match (the same guard findDuplicates uses).
    return ha === hb && !ha.startsWith('err:');
  }

  private async partialHash(abs: string): Promise<string> {
    const info = await stat(abs).catch(() => null);
    if (!info) return `err:${abs}`;
    const head = { start: 0, end: Math.min(PARTIAL_HASH_WINDOW, info.size) - 1 };
    const tail = { start: Math.max(0, info.size - PARTIAL_HASH_WINDOW), end: info.size - 1 };
    // Small files: one pass covers everything, and the ranges would overlap.
    const ranges = info.size <= PARTIAL_HASH_WINDOW * 2 ? [{ start: 0, end: info.size - 1 }] : [head, tail];
    const h = createHash('sha256');
    h.update(String(info.size));
    for (const r of ranges) {
      if (r.end < r.start) continue;
      const ok = await new Promise<boolean>((resolve) => {
        const s = createReadStream(abs, r);
        s.on('data', (d) => h.update(d));
        s.on('end', () => resolve(true));
        s.on('error', () => resolve(false));
      });
      if (!ok) return `err:${abs}`;
    }
    return h.digest('hex');
  }

  /** Flatten a release name into the fields the operator needs to choose. */
  private describe(abs: string, name: string, size: number, modifiedAt: Date | null): ConflictFileInfo {
    const meta = parseTorrentName(name);
    return {
      path: this.safety.toRelative(abs),
      name,
      size,
      modifiedAt: modifiedAt ? modifiedAt.toISOString() : null,
      show: meta.title,
      season: meta.season,
      episode: meta.episode,
      resolution: meta.resolution,
      source: meta.source,
      codec: meta.codec,
      releaseGroup: meta.releaseGroup,
      proper: meta.proper,
      repack: meta.repack,
    };
  }

  /**
   * Which release wins, by the same scoring the upgrade path uses. Asked in both
   * directions because `compareQuality` answers "is A strictly better than B" —
   * neither direction winning means they are equivalent on every dimension that
   * counts (codec-only differences deliberately do not count as an upgrade).
   */
  private judge(sourceName: string, targetName: string): { verdict: QualityVerdict; verdictReasons: string[] } {
    const forward = compareQuality(sourceName, targetName);
    if (forward.better) return { verdict: 'source_better', verdictReasons: forward.reasons };
    const reverse = compareQuality(targetName, sourceName);
    if (reverse.better) return { verdict: 'target_better', verdictReasons: reverse.reasons };
    return { verdict: 'equivalent', verdictReasons: [] };
  }

  /**
   * The default selection. Destructive defaults are only offered where the
   * evidence is unambiguous: identical bytes make the source provably redundant,
   * and a strictly better release is a clear upgrade. Anything else defaults to
   * `skip` — a dialog that pre-selects a guess is worse than one that asks.
   */
  private recommend(kind: ConflictKind, verdict: QualityVerdict): ConflictResolution {
    if (kind === 'identical') return 'delete_source';
    if (kind === 'same_episode' && verdict === 'source_better') return 'replace';
    if (kind === 'same_episode' && verdict === 'target_better') return 'delete_source';
    return 'skip';
  }

  private allowedFor(kind: ConflictKind): ConflictResolution[] {
    // `keep_both` is meaningless for identical bytes — it would file the same
    // content twice under two names.
    return kind === 'identical'
      ? ['delete_source', 'replace', 'skip']
      : ['replace', 'keep_both', 'delete_source', 'skip'];
  }
}
