import { Injectable, NotFoundException } from '@nestjs/common';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { FilePathService } from '../files/file-path.service';

const SUBTITLE_EXT = new Set(['.srt', '.ass', '.ssa', '.sub', '.vtt', '.idx']);

/** Common language tokens → ISO 639-1 (best effort). */
const LANG_MAP: Record<string, string> = {
  en: 'en', eng: 'en', english: 'en',
  es: 'es', spa: 'es', spanish: 'es',
  fr: 'fr', fre: 'fr', fra: 'fr', french: 'fr',
  de: 'de', ger: 'de', deu: 'de', german: 'de',
  it: 'it', ita: 'it', italian: 'it',
  pt: 'pt', por: 'pt', portuguese: 'pt',
  nl: 'nl', dut: 'nl', nld: 'nl', dutch: 'nl',
  ja: 'ja', jpn: 'ja', japanese: 'ja',
  ko: 'ko', kor: 'ko', korean: 'ko',
  zh: 'zh', chi: 'zh', zho: 'zh', chinese: 'zh',
  ru: 'ru', rus: 'ru', russian: 'ru',
  ar: 'ar', ara: 'ar', arabic: 'ar',
  pl: 'pl', pol: 'pl', polish: 'pl',
  sv: 'sv', swe: 'sv', swedish: 'sv',
  da: 'da', dan: 'da', danish: 'da',
  no: 'no', nor: 'no', norwegian: 'no',
  fi: 'fi', fin: 'fi', finnish: 'fi',
};

export interface ParsedSubtitle {
  language: string;
  forced: boolean;
  sdh: boolean;
}

/**
 * Derive subtitle attributes from a sidecar filename. Handles patterns such as
 * `Movie.en.srt`, `Movie.eng.forced.srt`, `Movie.en.sdh.srt`,
 * `Movie.English.hi.vtt`. Pure — exported for unit testing.
 */
export function parseSubtitleFilename(filename: string): ParsedSubtitle {
  const base = filename.replace(/\.[^.]+$/, ''); // drop extension
  const tokens = base.split(/[.\s_-]+/).map((t) => t.toLowerCase());

  let forced = false;
  let sdh = false;
  let language = 'und'; // undetermined

  // Inspect trailing tokens (language/flags come after the base name).
  for (const tok of tokens) {
    if (tok === 'forced') forced = true;
    else if (tok === 'sdh' || tok === 'hi' || tok === 'cc') sdh = true;
    else if (LANG_MAP[tok]) language = LANG_MAP[tok];
  }

  return { language, forced, sdh };
}

/**
 * Discovers sidecar subtitle files next to a MediaItem's video files (within
 * the ops hard roots) and records them as MediaSubtitle rows.
 */
@Injectable()
export class MediaSubtitleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filePath: FilePathService,
  ) {}

  private async itemWithFiles(itemId: string) {
    const item = await this.prisma.mediaItem.findUnique({
      where: { id: itemId },
      include: { files: true, subtitles: true },
    });
    if (!item) throw new NotFoundException('Item not found');
    return item;
  }

  /** Scan the directories of an item's files for sidecar subtitles. */
  async scan(itemId: string) {
    const item = await this.itemWithFiles(itemId);
    const dirs = new Set<string>();
    const baseNames = new Set<string>();
    for (const f of item.files) {
      dirs.add(path.dirname(f.path));
      baseNames.add(path.basename(f.path, path.extname(f.path)));
    }

    const found: Array<{ path: string; parsed: ParsedSubtitle }> = [];
    for (const dir of dirs) {
      let safeDir: string;
      try {
        safeDir = this.filePath.assertWithinHardRoots(dir);
      } catch {
        continue; // outside allowed roots — skip
      }
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(safeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!SUBTITLE_EXT.has(ext)) continue;
        // Only match subtitles that belong to one of this item's files.
        const belongs = [...baseNames].some((b) =>
          entry.name.toLowerCase().startsWith(b.toLowerCase()),
        );
        if (!belongs) continue;
        found.push({
          path: path.join(safeDir, entry.name),
          parsed: parseSubtitleFilename(entry.name),
        });
      }
    }

    const existingPaths = new Set(item.subtitles.map((s) => s.path));
    let created = 0;
    for (const sub of found) {
      if (existingPaths.has(sub.path)) continue;
      await this.prisma.mediaSubtitle.create({
        data: {
          itemId,
          path: sub.path,
          language: sub.parsed.language,
          forced: sub.parsed.forced,
          sdh: sub.parsed.sdh,
          source: 'sidecar',
        },
      });
      created++;
    }

    return { itemId, found: found.length, created };
  }

  /** List an item's known subtitles. */
  async list(itemId: string) {
    await this.itemWithFiles(itemId);
    return this.prisma.mediaSubtitle.findMany({
      where: { itemId },
      orderBy: [{ language: 'asc' }, { forced: 'asc' }],
    });
  }

  /**
   * Report which of the preferred languages are missing for an item. Defaults
   * to English when no preference list is supplied.
   */
  async detectMissing(itemId: string, preferred: string[] = ['en']) {
    const item = await this.itemWithFiles(itemId);
    const present = new Set(item.subtitles.map((s) => s.language));
    const missing = preferred.filter((l) => !present.has(l));
    return {
      itemId,
      present: [...present],
      missing,
      hasAny: item.subtitles.length > 0,
    };
  }
}
