/**
 * Local Subtitle Repository — a fully offline provider that scans a configured
 * folder for subtitles matching the media. Useful for a curated on-disk stash and
 * for air-gapped installs. Always available; no network, no key.
 *
 * Filesystem access is confined to the ops hard roots via an injected guard (the
 * repo path and every file read are validated by FilePathService), so a poisoned
 * config row can never escape the allow-list.
 */
import { Logger } from '@nestjs/common';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import {
  DownloadedSubtitle,
  NormalizedSubtitle,
  ProviderHealth,
  SUBTITLE_FORMATS,
  SubtitleProvider,
  SubtitleProviderCapabilities,
  SubtitleSearchQuery,
  detectSubtitleFormat,
} from './subtitle-provider';

/** The slice of FilePathService the provider needs — keeps it DI-light + testable. */
export interface FsGuard {
  assertWithinHardRoots(requested: string): string;
}

export interface LocalRepoConfig {
  repoPath?: string | null;
}

const LANG2 = new Set(['en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'ja', 'ko', 'zh', 'ru', 'ar', 'pl', 'sv', 'da', 'no', 'fi']);
const LANG3: Record<string, string> = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt',
  dut: 'nl', nld: 'nl', jpn: 'ja', kor: 'ko', chi: 'zh', zho: 'zh', rus: 'ru', ara: 'ar',
};

/** Collapse a name to lower-case alphanumeric-word form. Pure. */
export function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Derive language + forced/sdh flags from a subtitle filename. Pure. */
export function subtitleLangFromName(name: string): { language: string; forced: boolean; sdh: boolean } {
  const base = name.replace(/\.[^.]+$/, '');
  let language = 'und';
  let forced = false;
  let sdh = false;
  for (const tok of base.toLowerCase().split(/[.\s_-]+/)) {
    if (tok === 'forced') forced = true;
    else if (tok === 'sdh' || tok === 'hi' || tok === 'cc') sdh = true;
    else if (LANG2.has(tok)) language = tok;
    else if (LANG3[tok]) language = LANG3[tok];
  }
  return { language, forced, sdh };
}

/**
 * Score how well a subtitle filename matches the query. 0 = no match. Requires a
 * majority of the title's words, and — for an episode query — the exact SxxEyy
 * (so it never returns the wrong episode). Pure.
 */
export function localMatchScore(filename: string, query: SubtitleSearchQuery): number {
  const hay = normalizeToken(filename);
  const joined = hay.replace(/ /g, '');
  let score = 0;

  const title = normalizeToken(query.title ?? '');
  if (title) {
    const tokens = title.split(' ').filter((t) => t.length > 1);
    const present = tokens.filter((t) => hay.includes(t)).length;
    if (tokens.length > 0 && present < Math.ceil(tokens.length / 2)) return 0;
    score += present;
  } else if (!query.releaseName) {
    return 0;
  }

  if (query.season != null && query.episode != null) {
    const se = `s${String(query.season).padStart(2, '0')}e${String(query.episode).padStart(2, '0')}`;
    if (!joined.includes(se)) return 0; // episode requested but not this one
    score += 2;
  }
  return score;
}

export class LocalRepositoryProvider implements SubtitleProvider {
  readonly name = 'local';
  private readonly logger = new Logger('LocalRepositoryProvider');

  constructor(private readonly config: LocalRepoConfig, private readonly guard: FsGuard) {}

  validateConfiguration(): boolean {
    return !!this.config.repoPath;
  }

  getCapabilities(): SubtitleProviderCapabilities {
    return {
      hashSearch: false,
      releaseSearch: true,
      imdbSearch: false,
      tmdbSearch: false,
      tvdbSearch: false,
      seriesSearch: true,
      forcedSubtitles: true,
      hearingImpaired: true,
      machineTranslation: false,
    };
  }
  supportsHashSearch() { return false; }
  supportsReleaseSearch() { return true; }
  supportsImdbSearch() { return false; }
  supportsTmdbSearch() { return false; }
  supportsTvdbSearch() { return false; }
  supportsSeriesSearch() { return true; }
  supportsForcedSubtitles() { return true; }
  supportsHearingImpaired() { return true; }
  supportsMachineTranslation() { return false; }

  async healthCheck(): Promise<ProviderHealth> {
    if (!this.config.repoPath) return { healthy: false, message: 'repository path not set' };
    try {
      const safe = this.guard.assertWithinHardRoots(this.config.repoPath);
      await readdir(safe);
      return { healthy: true };
    } catch (err) {
      return { healthy: false, message: (err as Error).message };
    }
  }

  /** Bounded recursive walk for subtitle files (depth + file caps). */
  private async walk(root: string): Promise<string[]> {
    const out: string[] = [];
    const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
    while (stack.length && out.length < 5000) {
      const { dir, depth } = stack.pop()!;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < 4) stack.push({ dir: full, depth: depth + 1 });
        } else if (SUBTITLE_FORMATS.has(path.extname(e.name).slice(1).toLowerCase())) {
          out.push(full);
        }
      }
    }
    return out;
  }

  async search(query: SubtitleSearchQuery): Promise<NormalizedSubtitle[]> {
    if (!this.config.repoPath) return [];
    let root: string;
    try {
      root = this.guard.assertWithinHardRoots(this.config.repoPath);
    } catch {
      return [];
    }
    const wantLangs = (query.languages ?? []).map((l) => l.toLowerCase());
    const files = await this.walk(root);
    const out: NormalizedSubtitle[] = [];
    for (const file of files) {
      const base = path.basename(file);
      const score = localMatchScore(base, query);
      if (score <= 0) continue;
      const lang = subtitleLangFromName(base);
      if (wantLangs.length && lang.language !== 'und' && !wantLangs.includes(lang.language)) continue;
      out.push({
        provider: this.name,
        providerFileId: file,
        language: lang.language,
        releaseName: base,
        filename: base,
        movieHash: null,
        season: query.season ?? null,
        episode: query.episode ?? null,
        hearingImpaired: lang.sdh,
        forced: lang.forced,
        trustedUploader: false,
        machineTranslated: false,
        downloadUrl: `local:${file}`,
        matchLevel: score >= 2 ? 2 : 4,
        rawMetadata: { path: file },
      });
    }
    return out;
  }

  async download(candidate: NormalizedSubtitle): Promise<DownloadedSubtitle> {
    const raw = candidate.providerFileId ?? candidate.downloadUrl?.replace(/^local:/, '');
    if (!raw) throw new Error('candidate has no local path');
    const safe = this.guard.assertWithinHardRoots(raw);
    const content = await readFile(safe, 'utf8');
    const format = detectSubtitleFormat(safe) ?? 'srt';
    return { content, format, byteLength: Buffer.byteLength(content) };
  }
}
