import { BadRequestException, Injectable } from '@nestjs/common';
import { readdir, rm } from 'node:fs/promises';
import * as path from 'node:path';
import {
  CLEANUP_CATEGORIES,
  CLEANUP_CATEGORY_LABELS,
  WS_EVENTS,
  type CleanupCandidate,
  type CleanupCategory,
  type CleanupCategoryGroup,
  type CleanupExecuteResult,
  type CleanupPreview,
} from '@ultratorrent/shared';
import { AuditService } from '../audit/audit.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { FilePathService, type FileOpContext } from './file-path.service';
import { TRASH_DIR_NAME } from './path-safety';
import { computeSize, statSafe } from './file-fs.util';
import { TrashService } from './trash.service';
import type { CleanupExecuteDto, CleanupPreviewDto } from './dto/file.dto';

const VIDEO_EXT = new Set(['mkv', 'mp4', 'avi', 'mov', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', 'flv', 'webm']);
const SUBTITLE_EXT = new Set(['srt', 'sub', 'ass', 'ssa', 'vtt', 'idx', 'smi']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tbn', 'webp']);
const PARTIAL_EXT = new Set(['part', 'crdownload', 'partial', 'aria2', '!ut', 'bc!']);
const TEMP_EXT = new Set(['tmp', 'temp', 'bak']);
const HIDDEN_TEMP_NAMES = new Set(['thumbs.db', '.ds_store', 'desktop.ini']);

interface ScanEntry {
  abs: string;
  rel: string;
  name: string;
  ext: string;
  isDir: boolean;
  size: number;
  dir: string; // parent absolute dir
}

/**
 * Cleanup engine — scans a folder, classifies cleanup candidates by category,
 * estimates recoverable space, and (only on explicit, audited request) removes
 * the selected items. Never deletes automatically; preview is read-only.
 */
@Injectable()
export class FileCleanupService {
  constructor(
    private readonly paths: FilePathService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly trash: TrashService,
  ) {}

  private get safety() {
    return this.paths.safety;
  }

  // --- preview -------------------------------------------------------------

  async preview(dto: CleanupPreviewDto): Promise<CleanupPreview> {
    const root = await this.safety.resolveExisting(dto.path);
    const info = await statSafe(root);
    if (!info || !info.isDirectory()) throw new BadRequestException('Cleanup target must be a directory');

    const wanted = new Set<CleanupCategory>(dto.categories ?? CLEANUP_CATEGORIES);
    const entries = await this.walk(root);
    const byDir = this.groupByDir(entries);
    const claimed = new Set<string>();
    const candidates: CleanupCandidate[] = [];

    const add = (e: ScanEntry, category: CleanupCategory, reason: string) => {
      if (claimed.has(e.abs) || !wanted.has(category)) return;
      claimed.add(e.abs);
      candidates.push({ path: e.rel, name: e.name, isDirectory: e.isDir, size: e.size, category, reason });
    };

    // Duplicate detection (by size then sha-256) over plain files.
    const dupPaths = wanted.has('duplicate_files') ? await this.findDuplicates(entries) : new Map();

    for (const e of entries) {
      if (!e.isDir) {
        if (PARTIAL_EXT.has(e.ext)) add(e, 'partial_downloads', `Partial download (.${e.ext})`);
        else if (e.size === 0) add(e, 'zero_byte_files', 'Zero-byte file');
        else if (this.isSample(e)) add(e, 'sample_files', 'Sample file');
        else if (dupPaths.has(e.abs)) add(e, 'duplicate_files', `Duplicate of ${this.safety.toRelative(dupPaths.get(e.abs))}`);
        else if (SUBTITLE_EXT.has(e.ext) && !this.dirHasVideo(byDir, e.dir)) add(e, 'orphan_subtitles', 'Subtitle with no video in its folder');
        else if (IMAGE_EXT.has(e.ext) && !this.dirHasVideo(byDir, e.dir)) add(e, 'orphan_artwork', 'Artwork with no video in its folder');
        else if (e.ext === 'nfo') add(e, 'nfo_files', 'NFO metadata file');
        else if (e.ext === 'sfv') add(e, 'sfv_files', 'SFV checksum file');
        else if (e.ext === 'txt') add(e, 'txt_files', 'Text file');
        else if (this.isHiddenTemp(e)) add(e, 'hidden_temp_files', 'Hidden or temporary file');
      }
    }

    // Empty folders last (deepest first so a folder emptied by the above counts).
    if (wanted.has('empty_folders')) {
      for (const e of entries.filter((x) => x.isDir).sort((a, b) => b.abs.length - a.abs.length)) {
        if (await this.isEmptyDir(e.abs, claimed)) add(e, 'empty_folders', 'Empty folder');
      }
    }

    return this.group(this.safety.toRelative(root), candidates);
  }

  // --- execute -------------------------------------------------------------

  async execute(dto: CleanupExecuteDto, ctx: FileOpContext = {}): Promise<CleanupExecuteResult> {
    const root = await this.safety.resolveExisting(dto.path);
    let removed = 0;
    let failed = 0;
    let bytes = 0;

    for (const rel of dto.paths) {
      try {
        const abs = await this.safety.resolveExisting(rel);
        // Confine cleanup strictly to the scanned subtree.
        if (abs !== root && !abs.startsWith(root + path.sep)) {
          throw new BadRequestException('Candidate is outside the scanned folder');
        }
        this.safety.assertDeletable(abs);
        const size = await computeSize(abs);
        if (dto.permanent) {
          await rm(abs, { recursive: true, force: true });
        } else {
          await this.trash.moveToTrash(abs, ctx);
        }
        removed += 1;
        bytes += size;
      } catch {
        failed += 1;
      }
    }

    const result: CleanupExecuteResult = {
      removed,
      failed,
      bytesReclaimed: bytes,
      mode: dto.permanent ? 'permanent' : 'trash',
    };
    await this.audit.record({
      userId: ctx.userId,
      action: 'file.cleanup_execute',
      objectType: 'folder',
      objectId: this.safety.toRelative(root),
      result: failed > 0 ? 'failure' : 'success',
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { ...result, requested: dto.paths.length },
    });
    this.realtime.broadcast(WS_EVENTS.FILES_CLEANUP_COMPLETED, {
      root: this.safety.toRelative(root),
      ...result,
      at: new Date().toISOString(),
    });
    return result;
  }

  // --- scanning helpers ----------------------------------------------------

  private async walk(root: string): Promise<ScanEntry[]> {
    const out: ScanEntry[] = [];
    const recurse = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name === TRASH_DIR_NAME) continue;
        const abs = path.join(dir, e.name);
        const isDir = e.isDirectory();
        const s = await statSafe(abs);
        out.push({
          abs,
          rel: this.safety.toRelative(abs),
          name: e.name,
          ext: isDir ? '' : path.extname(e.name).replace(/^\./, '').toLowerCase(),
          isDir,
          size: isDir ? 0 : (s?.size ?? 0),
          dir,
        });
        if (isDir) await recurse(abs);
      }
    };
    await recurse(root);
    return out;
  }

  private groupByDir(entries: ScanEntry[]): Map<string, ScanEntry[]> {
    const map = new Map<string, ScanEntry[]>();
    for (const e of entries) {
      const list = map.get(e.dir) ?? [];
      list.push(e);
      map.set(e.dir, list);
    }
    return map;
  }

  private dirHasVideo(byDir: Map<string, ScanEntry[]>, dir: string): boolean {
    return (byDir.get(dir) ?? []).some((e) => !e.isDir && VIDEO_EXT.has(e.ext));
  }

  private isSample(e: ScanEntry): boolean {
    return VIDEO_EXT.has(e.ext) && /(^|[^a-z])sample([^a-z]|$)/i.test(e.name);
  }

  private isHiddenTemp(e: ScanEntry): boolean {
    if (HIDDEN_TEMP_NAMES.has(e.name.toLowerCase())) return true;
    if (e.name.startsWith('.')) return true;
    if (e.name.endsWith('~')) return true;
    return TEMP_EXT.has(e.ext);
  }

  private async isEmptyDir(abs: string, claimed: Set<string>): Promise<boolean> {
    const entries = await readdir(abs, { withFileTypes: true }).catch(() => []);
    // A dir counts as empty if every child is already claimed for removal.
    return entries.every((e) => claimed.has(path.join(abs, e.name)));
  }

  /** Map of duplicate-file abs → the kept original's abs. */
  private async findDuplicates(entries: ScanEntry[]): Promise<Map<string, string>> {
    const bySize = new Map<number, ScanEntry[]>();
    for (const e of entries) {
      if (e.isDir || e.size === 0) continue;
      const list = bySize.get(e.size) ?? [];
      list.push(e);
      bySize.set(e.size, list);
    }
    const dups = new Map<string, string>();
    const { createHash } = await import('node:crypto');
    const { createReadStream } = await import('node:fs');
    const hashOf = (abs: string): Promise<string> =>
      new Promise((resolve) => {
        const h = createHash('sha256');
        const s = createReadStream(abs);
        s.on('data', (d) => h.update(d));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', () => resolve(`err:${abs}`));
      });

    for (const group of bySize.values()) {
      if (group.length < 2) continue;
      const seen = new Map<string, string>(); // hash → first abs
      for (const e of group) {
        const hash = await hashOf(e.abs);
        const original = seen.get(hash);
        if (original) dups.set(e.abs, original);
        else seen.set(hash, e.abs);
      }
    }
    return dups;
  }

  private group(root: string, candidates: CleanupCandidate[]): CleanupPreview {
    const groups: CleanupCategoryGroup[] = [];
    for (const category of CLEANUP_CATEGORIES) {
      const items = candidates.filter((c) => c.category === category);
      if (items.length === 0) continue;
      groups.push({
        category,
        label: CLEANUP_CATEGORY_LABELS[category],
        itemCount: items.length,
        totalSize: items.reduce((sum, i) => sum + i.size, 0),
        items,
      });
    }
    const totalItems = candidates.length;
    const totalSize = candidates.reduce((sum, c) => sum + c.size, 0);
    return { root, categories: groups, totalItems, totalSize, estimatedSpaceSaved: totalSize };
  }
}
