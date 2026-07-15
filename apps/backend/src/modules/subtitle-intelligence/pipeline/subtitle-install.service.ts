/**
 * Installs a validated subtitle as a sidecar next to its video, using the naming
 * convention Plex / Jellyfin / Emby / Kodi all read:
 *
 *   Movie (2020).en.srt
 *   Movie (2020).es-PR.srt
 *   Movie (2020).en.forced.srt
 *   Movie (2020).en.sdh.srt
 *   Show - S01E01.en.srt
 *
 * The write is confined to the ops hard roots (FilePathService), and it NEVER
 * overwrites an existing file it did not create — a colliding target gets a
 * numbered variant instead, so a hand-placed or previously-synced subtitle is
 * always preserved (spec: "keep both").
 */
import { Injectable } from '@nestjs/common';
import { access, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { FilePathService } from '../../files/file-path.service';

export interface SidecarSpec {
  /** ISO-639-1 or region tag, e.g. `en`, `es-PR`. */
  language: string;
  forced?: boolean;
  /** Hearing-impaired / SDH. */
  sdh?: boolean;
  /** Extension without the dot: srt | ass | vtt | sub. */
  format: string;
}

/**
 * Compose the sidecar filename for a video path. Pure — exported for tests.
 * Flag order matches the media-server convention: `<base>.<lang>[.forced][.sdh].<ext>`.
 */
export function sidecarPath(videoPath: string, spec: SidecarSpec): string {
  const dir = path.dirname(videoPath);
  const base = path.basename(videoPath, path.extname(videoPath));
  const parts = [base, spec.language];
  if (spec.forced) parts.push('forced');
  if (spec.sdh) parts.push('sdh');
  return path.join(dir, `${parts.join('.')}.${spec.format.replace(/^\./, '')}`);
}

export interface InstallResult {
  path: string;
  /** True when the ideal name was taken and a numbered variant was used. */
  variant: boolean;
}

@Injectable()
export class SubtitleInstallService {
  constructor(private readonly filePath: FilePathService) {}

  private async exists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write `content` as a sidecar beside `videoPath`. Confined to the hard roots;
   * a colliding target is never clobbered — a `.1`/`.2`/… variant is used.
   */
  async install(videoPath: string, content: string, spec: SidecarSpec): Promise<InstallResult> {
    const ideal = sidecarPath(videoPath, spec);
    const safeIdeal = this.filePath.assertWithinHardRoots(ideal);

    let target = safeIdeal;
    let variant = false;
    if (await this.exists(target)) {
      const ext = path.extname(safeIdeal);
      const stem = safeIdeal.slice(0, safeIdeal.length - ext.length);
      for (let n = 1; n <= 99; n++) {
        const candidate = this.filePath.assertWithinHardRoots(`${stem}.${n}${ext}`);
        if (!(await this.exists(candidate))) {
          target = candidate;
          variant = true;
          break;
        }
      }
    }

    await writeFile(target, content, 'utf8');
    return { path: target, variant };
  }
}
