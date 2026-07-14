/**
 * Intelligent media renamer — pure, dependency-free planning logic.
 *
 * Given the files of a completed download plus parsed release metadata, it
 * builds a rename/move plan that media servers (Plex/Jellyfin/Emby/Kodi) can
 * scan. No filesystem or network access here — the service layer executes the
 * plan and (optionally) enriches metadata. This keeps it trivially testable.
 */
import { parseTorrentName, ParsedTorrentMeta } from './../rss/torrent-name-parser';
import * as path from 'node:path';

export type MediaKind = 'tv' | 'anime' | 'movie' | 'music' | 'audiobook' | 'general';
export type Preset = 'plex' | 'jellyfin' | 'emby' | 'kodi' | 'custom';
export type RenameMode =
  | 'preview'
  | 'rename_in_place'
  | 'rename_move'
  | 'copy'
  | 'hardlink'
  | 'symlink';

export interface MediaFileInput {
  /** Path of the file (relative to the torrent base or absolute). */
  path: string;
  size: number;
}

export interface EpisodeMeta {
  episodeTitle?: string;
  seriesTitle?: string;
  movieTitle?: string;
  year?: number;
}

/**
 * Junk-cleanup rules applied during a rename/move: files that should be **erased**
 * from the download folder before the important files are relocated. Global by
 * design (one list for every library). Only ever consulted for the two modes that
 * relocate the original (`rename_in_place`/`rename_move`) — never for copy/link,
 * where deleting the source would touch the seeding copy.
 */
export interface CleanupRules {
  /** Master switch — nothing is ever deleted when false. */
  enabled: boolean;
  /**
   * Basename globs (`*`/`?`) whose matches are deleted, e.g. `YTS*.txt`,
   * `RARBG.txt`, `www.*`, `*.jpg`. A primary video file is NEVER deleted even if
   * a pattern would match it.
   */
  deleteGlobs: string[];
  /**
   * ISO-639 language codes to KEEP among subtitles (2- or 3-letter, e.g.
   * `["en","es"]`). Any subtitle whose parsed language tag isn't in this list is
   * deleted. Empty = keep every subtitle. A subtitle with no detectable language
   * tag is always kept (can't safely classify it).
   */
  subtitleKeepLanguages: string[];
  /** Remove the source folder after a move if it's left empty. */
  pruneEmptyDirs: boolean;
  /** Delete a leftover `.torrent` file sitting in the source folder. */
  removeLeftoverTorrent: boolean;
}

export const DEFAULT_CLEANUP_RULES: CleanupRules = {
  enabled: false,
  deleteGlobs: [],
  subtitleKeepLanguages: [],
  pruneEmptyDirs: false,
  removeLeftoverTorrent: false,
};

export interface RenameContext {
  /** The release/folder name to parse for show/movie identity. */
  sourceName: string;
  files: MediaFileInput[];
  preset: Preset;
  mode: RenameMode;
  /** Destination library root (e.g. /media/TV). */
  libraryPath: string;
  /** Optional override template; falls back to the preset default for the kind. */
  template?: string;
  /** Optional metadata enrichment (episode/movie titles). */
  meta?: EpisodeMeta;
  /** Min bytes for a file to NOT be treated as a sample (default 50 MB). */
  sampleMaxBytes?: number;
  /** Optional junk-cleanup rules (delete patterns + subtitle language filter). */
  cleanup?: CleanupRules;
}

export type PlanAction =
  | 'rename'
  | 'move'
  | 'copy'
  | 'hardlink'
  | 'symlink'
  | 'delete'
  | 'skip';

export interface RenamePlanItem {
  source: string;
  destination: string | null;
  action: PlanAction;
  kind: MediaKind;
  reason: string;
  skipped: boolean;
  isSubtitle: boolean;
  isSample: boolean;
  isExtra: boolean;
}

export interface RenamePlan {
  mode: RenameMode;
  preset: Preset;
  libraryPath: string;
  kind: MediaKind;
  parsed: ParsedTorrentMeta;
  items: RenamePlanItem[];
  warnings: string[];
}

const VIDEO_EXT = new Set(['.mkv', '.mp4', '.avi', '.m4v', '.ts', '.m2ts', '.wmv', '.mov', '.webm']);
const SUBTITLE_EXT = new Set(['.srt', '.ass', '.ssa', '.sub', '.idx', '.vtt']);
const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma']);
const AUDIOBOOK_EXT = new Set(['.m4b', '.aa', '.aax']);
const EXTRA_HINTS = /\b(featurette|extras?|behind[ ._-]the[ ._-]scenes|deleted|interview|trailer|bonus)\b/i;
const SAMPLE_HINTS = /\bsample\b/i;
const LANG_TAG = /\.([a-z]{2,3})(\.(forced|sdh|cc))?$/i;

// --- preset templates ----------------------------------------------------

export interface PresetTemplates {
  tv: string;
  anime: string;
  movie: string;
  music: string;
  audiobook: string;
}

export const PRESET_TEMPLATES: Record<Exclude<Preset, 'custom'>, PresetTemplates> = {
  plex: {
    tv: '{Series Title}/Season {season}/{Series Title} - S{season:00}E{episode:00}{episodeEnd? - E{episodeEnd:00}} - {Episode Title}.{ext}',
    anime: '{Series Title}/Season {season}/{Series Title} - S{season:00}E{episode:00} - {Episode Title}.{ext}',
    movie: '{Movie Title} ({year})/{Movie Title} ({year}) - {Resolution}.{ext}',
    music: '{Artist}/{Album}/{Track:00} {Title}.{ext}',
    audiobook: '{Artist}/{Album}/{Album}.{ext}',
  },
  jellyfin: {
    tv: '{Series Title}/Season {season}/{Series Title} S{season:00}E{episode:00} {Episode Title}.{ext}',
    anime: '{Series Title}/Season {season}/{Series Title} S{season:00}E{episode:00} {Episode Title}.{ext}',
    movie: '{Movie Title} ({year})/{Movie Title} ({year}) [{Resolution}].{ext}',
    music: '{Artist}/{Album}/{Track:00} - {Title}.{ext}',
    audiobook: '{Artist}/{Album}/{Album}.{ext}',
  },
  emby: {
    tv: '{Series Title}/Season {season}/{Series Title} - S{season:00}E{episode:00} - {Episode Title}.{ext}',
    anime: '{Series Title}/Season {season}/{Series Title} - S{season:00}E{episode:00} - {Episode Title}.{ext}',
    movie: '{Movie Title} ({year})/{Movie Title} ({year}).{ext}',
    music: '{Artist}/{Album}/{Track:00} {Title}.{ext}',
    audiobook: '{Artist}/{Album}/{Album}.{ext}',
  },
  kodi: {
    tv: '{Series Title}/Season {season}/{Series Title} S{season:00}E{episode:00}.{ext}',
    anime: '{Series Title}/Season {season}/{Series Title} S{season:00}E{episode:00}.{ext}',
    movie: '{Movie Title} ({year})/{Movie Title} ({year}) {Resolution}.{ext}',
    music: '{Artist}/{Album}/{Track:00} - {Title}.{ext}',
    audiobook: '{Artist}/{Album}/{Album}.{ext}',
  },
};

// --- helpers -------------------------------------------------------------

/** Strip characters illegal on common filesystems; collapse whitespace. */
export function sanitizeSegment(input: string): string {
  return input
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[ .]+$/g, '')
    .trim();
}

function pad(value: number | string, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Compile a filename glob (`*` = any run, `?` = one char) into a whole-string,
 * case-insensitive RegExp. All other regex metacharacters are escaped, so a
 * pattern like `YTS*.txt` matches literally except for its wildcards.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** True when `basename` matches any of the (best-effort compiled) globs. */
export function matchesAnyGlob(basename: string, globs: string[]): boolean {
  return globs.some((g) => {
    try {
      return globToRegExp(g).test(basename);
    } catch {
      return false; // a malformed pattern never matches (and never throws)
    }
  });
}

/** Common ISO-639-2 → 639-1 aliases so a `.eng`/`.spa` sub matches a `en`/`es` keep-list. */
const LANG_ALIASES: Record<string, string> = {
  eng: 'en', spa: 'es', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it',
  por: 'pt', dut: 'nl', nld: 'nl', jpn: 'ja', chi: 'zh', zho: 'zh', rus: 'ru',
  kor: 'ko', ara: 'ar', hin: 'hi', swe: 'sv', nor: 'no', dan: 'da', fin: 'fi', pol: 'pl',
};

/** Normalize a language code to its 639-1 form when known (else lower-cased as-is). */
export function normalizeLang(code: string): string {
  const c = code.toLowerCase();
  return LANG_ALIASES[c] ?? c;
}

/** Classify a single file by extension + name hints. */
export function classifyFile(
  filePath: string,
  parsedKind: MediaKind,
  sampleMaxBytes: number,
  size: number,
): { kind: MediaKind; isSubtitle: boolean; isSample: boolean; isExtra: boolean; ext: string } {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  const inSampleDir = /(^|[\\/])sample([\\/]|$)/i.test(filePath);
  const isSample =
    (SAMPLE_HINTS.test(base) || inSampleDir) &&
    VIDEO_EXT.has(ext) &&
    size <= sampleMaxBytes;
  const isSubtitle = SUBTITLE_EXT.has(ext);
  const isExtra = EXTRA_HINTS.test(base) && !isSubtitle;

  let kind: MediaKind = parsedKind;
  if (AUDIOBOOK_EXT.has(ext)) kind = 'audiobook';
  else if (AUDIO_EXT.has(ext)) kind = parsedKind === 'audiobook' ? 'audiobook' : 'music';
  else if (!VIDEO_EXT.has(ext) && !isSubtitle) kind = 'general';

  return { kind, isSubtitle, isSample, isExtra, ext };
}

/** Map parser content type → renamer media kind. */
export function kindFromParsed(parsed: ParsedTorrentMeta): MediaKind {
  switch (parsed.contentType) {
    case 'tv_episode':
    case 'daily':
      return 'tv';
    case 'anime_episode':
      return 'anime';
    case 'movie':
      return 'movie';
    default:
      return 'general';
  }
}

interface TemplateTokens {
  [key: string]: string | number | undefined;
}

/**
 * Render a naming template. Supports `{Token}`, numeric padding `{Token:00}`,
 * and optional segments `{cond?literal{Token:00}}` that render only when the
 * referenced token is present.
 */
export function renderTemplate(template: string, tokens: TemplateTokens): string {
  // Optional segments: {name?...} — emitted only if `name` token is truthy.
  let out = template.replace(/\{(\w+)\?([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g, (_m, name, inner) => {
    const present = tokens[name] !== undefined && tokens[name] !== '' && tokens[name] !== null;
    return present ? inner : '';
  });

  // Plain + padded tokens.
  out = out.replace(/\{([\w ]+?)(?::(\d+))?\}/g, (_m, rawName, width) => {
    const name = String(rawName).trim();
    const val = tokens[name];
    if (val === undefined || val === null || val === '') return '';
    if (width) return pad(val as number, String(width).length);
    return String(val);
  });

  // Sanitize each path segment, drop empties, tidy separators left by missing tokens.
  const segments = out.split('/').map((seg) =>
    sanitizeSegment(
      seg
        .replace(/\s*-\s*-\s*/g, ' - ') // collapse doubled separators
        .replace(/\s*-\s*(\.\w+)$/, '$1') // drop a dangling " - " before .ext
        .replace(/\s+(\.\w+)$/, '$1') // drop a stray space before .ext
        .replace(/\s+-\s*$/g, ''), // trailing separator
    ),
  );
  return segments.filter((s) => s.length > 0).join('/');
}

/**
 * A rendered relative path is safe to rename a *primary media file* onto only if
 * it has real content, carries no unresolved template braces (`{`/`}` — the
 * signature of a corrupt template), and ends in the file's own extension. A bare
 * `{` template, an empty render, or a truncated template all fail this and must
 * never be used as a destination (they would overwrite the source file's name).
 */
export function isRenderedPathSafe(rel: string, ext: string): boolean {
  if (!rel || !rel.trim()) return false;
  if (/[{}]/.test(rel)) return false;
  const base = path.basename(rel);
  if (!base || base === ext) return false;
  return ext ? base.toLowerCase().endsWith(ext.toLowerCase()) : true;
}

function templateForKind(preset: Preset, kind: MediaKind, override?: string): string {
  if (override && override.trim()) return override;
  const p = preset === 'custom' ? 'plex' : preset;
  const t = PRESET_TEMPLATES[p];
  switch (kind) {
    case 'tv': return t.tv;
    case 'anime': return t.anime;
    case 'movie': return t.movie;
    case 'music': return t.music;
    case 'audiobook': return t.audiobook;
    default: return '{General}.{ext}';
  }
}

/** Episode range detection: S02E05E06 or S02E05-E06 -> {start:5, end:6}. */
function episodeRange(sourceName: string): { start: number; end: number } | null {
  const m = /s\d{1,2}[ ._-]*e(\d{1,3})[ ._-]*(?:e|-e|-)(\d{1,3})/i.exec(sourceName.replace(/[._]/g, ' '));
  if (m) return { start: +m[1], end: +m[2] };
  return null;
}

// NB: season *folders* are unpadded ("Season 8"); the SxxEyy in filenames stays
// zero-padded (the media-server convention). `reuseExistingSeasonDir` in the
// executor also folds a differently-padded existing folder into this one.
function buildTokens(
  parsed: ParsedTorrentMeta,
  kind: MediaKind,
  ext: string,
  meta: EpisodeMeta | undefined,
  range: { start: number; end: number } | null,
): TemplateTokens {
  const cleanExt = ext.replace(/^\./, '');
  const series = meta?.seriesTitle ?? parsed.title ?? 'Unknown';
  const movie = meta?.movieTitle ?? parsed.title ?? 'Unknown';
  const season = parsed.season ?? (kind === 'tv' || kind === 'anime' ? 1 : undefined);
  const episode = parsed.episode ?? parsed.absoluteEpisode ?? undefined;
  return {
    'Series Title': series,
    'Movie Title': movie,
    season,
    episode,
    episodeEnd: range && range.end !== range.start ? range.end : undefined,
    'Episode Title': meta?.episodeTitle,
    year: meta?.year ?? parsed.year ?? undefined,
    Resolution: parsed.resolution ?? undefined,
    Source: parsed.source ?? undefined,
    Codec: parsed.codec ?? undefined,
    'Release Group': parsed.releaseGroup ?? undefined,
    General: series,
    ext: cleanExt,
  };
}

function modeToAction(mode: RenameMode): PlanAction {
  switch (mode) {
    case 'preview': return 'rename';
    case 'rename_in_place': return 'rename';
    case 'rename_move': return 'move';
    case 'copy': return 'copy';
    case 'hardlink': return 'hardlink';
    case 'symlink': return 'symlink';
  }
}

/** A "Season N" / "Specials" style container folder that groups episodes. */
export function isSeasonContainer(name: string): boolean {
  return (
    /^(season|series|saison|staffel|temporada|stagione|serie)[\s._-]*\d+$/i.test(name) ||
    /^specials$/i.test(name)
  );
}

/**
 * The show (or movie) folder a source file already lives in — i.e. its parent
 * directory, climbing past a "Season NN"/"Specials" container if present.
 */
export function showFolderRoot(source: string): string {
  const dir = path.dirname(source);
  return isSeasonContainer(path.basename(dir)) ? path.dirname(dir) : dir;
}

/**
 * Resolve a plan item's destination path for a `source` and its templated
 * relative path `rel` (e.g. `Show/Season 08/Show - S08E16 - Title.mkv`).
 *
 * `rename_in_place` keeps the file inside the **show folder it already lives in**
 * — whatever the RSS rule / existing library named it (with or without a year).
 * It only re-homes the file into the correct **season subfolder** and corrects
 * the filename; the template's leading show-folder segment is discarded, so a
 * missing/blank year can never fork `Show (year)/` into a bare `Show/`. Every
 * other mode re-roots the file under the library at the full templated path.
 * (Separate from `modeToAction`, which picks the filesystem verb.)
 *
 * In-place applies only to **absolute** sources (the media-library flow). The
 * torrent post-download flow passes base-relative paths and must re-root.
 */
function resolveDestination(ctx: RenameContext, source: string, rel: string): string {
  if (ctx.mode === 'rename_in_place' && path.isAbsolute(source)) {
    const parts = rel.split(path.sep);
    const belowShow = parts.length > 1 ? parts.slice(1).join(path.sep) : rel;
    return path.join(showFolderRoot(source), belowShow);
  }
  return path.join(ctx.libraryPath, rel);
}

/** Build a rename plan (no IO). */
export function buildRenamePlan(ctx: RenameContext): RenamePlan {
  const parsed = parseTorrentName(ctx.sourceName);
  const kind = kindFromParsed(parsed);
  const sampleMax = ctx.sampleMaxBytes ?? 50 * 1024 * 1024;
  const template = templateForKind(ctx.preset, kind, ctx.template);
  const range = episodeRange(ctx.sourceName);
  const action = modeToAction(ctx.mode);
  const warnings: string[] = [];
  const items: RenamePlanItem[] = [];
  const destSeen = new Map<string, string>();

  // Primary video destinations remembered so subtitles can mirror them.
  const videoDest: { source: string; destNoExt: string }[] = [];

  // Cleanup pass: mark junk for deletion BEFORE anything is moved. Only for the
  // two modes that relocate the original — deleting the source under copy/link
  // would touch the seeding copy. A primary video is never deletable.
  const toDelete = new Set<string>();
  const cleanup = ctx.cleanup;
  const cleanupActive = !!cleanup?.enabled && (ctx.mode === 'rename_in_place' || ctx.mode === 'rename_move');
  if (cleanupActive && cleanup) {
    const keepLangs = cleanup.subtitleKeepLanguages.map(normalizeLang);
    for (const f of ctx.files) {
      const c = classifyFile(f.path, kind, sampleMax, f.size);
      const base = path.basename(f.path);
      // Protect real content: never delete a non-sample video (a primary file).
      if (VIDEO_EXT.has(c.ext) && !c.isSample) continue;

      let reason = '';
      if (matchesAnyGlob(base, cleanup.deleteGlobs)) {
        reason = 'matched cleanup pattern';
      } else if (c.isSubtitle && keepLangs.length > 0) {
        const langMatch = LANG_TAG.exec(path.basename(f.path, c.ext));
        const lang = langMatch ? normalizeLang(langMatch[1]) : null;
        // Untagged subtitles are kept — we can't safely classify their language.
        if (lang && !keepLangs.includes(lang)) reason = `subtitle language "${lang}" not in keep-list`;
      }

      if (reason) {
        toDelete.add(f.path);
        items.push({ source: f.path, destination: null, action: 'delete', kind: c.kind, reason, skipped: false, isSubtitle: c.isSubtitle, isSample: c.isSample, isExtra: c.isExtra });
      }
    }
  }

  // First pass: videos + audio (the renamable primaries).
  for (const f of ctx.files) {
    if (toDelete.has(f.path)) continue; // slated for cleanup
    const c = classifyFile(f.path, kind, sampleMax, f.size);
    if (c.isSubtitle) continue; // handled in second pass

    if (c.isSample) {
      items.push({ source: f.path, destination: null, action: 'skip', kind: c.kind, reason: 'sample file ignored', skipped: true, isSubtitle: false, isSample: true, isExtra: false });
      continue;
    }
    if (c.kind === 'general') {
      // Deferred to the sidecar pass below — it needs the video destinations, which are
      // only known once this pass has run. Anything that turns out NOT to belong to a
      // video is emitted as a skip there, exactly as before.
      continue;
    }

    const tokens = buildTokens(parsed, c.kind, c.ext, ctx.meta, range);
    let rel = renderTemplate(template, tokens);

    // Guard: a corrupt/misconfigured template can render to garbage (e.g. a bare
    // `{` — an unclosed token is not a legal token AND `{` is not an illegal
    // filename char, so it survives sanitization). Renaming a primary video onto
    // such a name silently clobbers the file (every episode collapses to the same
    // `{`). Never move a primary onto an unresolved-brace or extension-less path —
    // leave it untouched and warn so the operator can fix the naming template.
    if (!isRenderedPathSafe(rel, c.ext)) {
      warnings.push(
        `Naming template produced an unsafe destination "${rel}" for "${f.path}"; ` +
          `file left untouched. Check this library's naming template.`,
      );
      items.push({ source: f.path, destination: null, action: 'skip', kind: c.kind, reason: 'invalid naming template', skipped: true, isSubtitle: false, isSample: false, isExtra: c.isExtra });
      continue;
    }

    if (c.isExtra) {
      // Route extras into an Extras/ subfolder beside the title folder.
      const dir = path.dirname(rel);
      rel = path.join(dir, 'Extras', sanitizeSegment(path.basename(f.path)));
      items.push({ source: f.path, destination: resolveDestination(ctx, f.path, rel), action, kind: c.kind, reason: 'extra/featurette', skipped: false, isSubtitle: false, isSample: false, isExtra: true });
      continue;
    }

    // Specials (season 0)
    if ((c.kind === 'tv' || c.kind === 'anime') && parsed.season === 0) {
      rel = rel.replace(/Season 0+\b/i, 'Specials');
    }

    const destination = resolveDestination(ctx, f.path, rel);
    if (destSeen.has(destination)) {
      warnings.push(`Duplicate destination "${destination}" from "${f.path}" and "${destSeen.get(destination)}".`);
    }
    destSeen.set(destination, f.path);
    videoDest.push({ source: f.path, destNoExt: destination.slice(0, destination.length - c.ext.length) });
    items.push({ source: f.path, destination, action, kind: c.kind, reason: range ? 'multi-episode video' : 'primary media file', skipped: false, isSubtitle: false, isSample: false, isExtra: false });
  }

  // Second pass: subtitles → match to a primary by shared base name; keep lang tag.
  for (const f of ctx.files) {
    if (toDelete.has(f.path)) continue; // slated for cleanup
    const ext = path.extname(f.path).toLowerCase();
    if (!SUBTITLE_EXT.has(ext)) continue;
    const subBase = path.basename(f.path, ext).toLowerCase();
    const langMatch = LANG_TAG.exec(path.basename(f.path, ext));
    const lang = langMatch ? `.${langMatch[1].toLowerCase()}` : '';

    // Best primary match: the video whose source basename shares the most.
    let best: { destNoExt: string } | null = null;
    let bestScore = -1;
    for (const v of videoDest) {
      const vBase = path.basename(v.source, path.extname(v.source)).toLowerCase();
      const score = commonPrefix(subBase, vBase);
      if (score > bestScore) { bestScore = score; best = v; }
    }
    if (!best) {
      items.push({ source: f.path, destination: null, action: 'skip', kind: 'general', reason: 'no matching video for subtitle', skipped: true, isSubtitle: true, isSample: false, isExtra: false });
      continue;
    }
    const destination = `${best.destNoExt}${lang}${ext}`;
    items.push({ source: f.path, destination, action, kind: 'general', reason: lang ? `subtitle (${lang.slice(1)}) matched to video` : 'subtitle matched to video', skipped: false, isSubtitle: true, isSample: false, isExtra: false });
  }

  // Third pass: metadata sidecars follow the video they describe.
  //
  // A `.nfo` / `-thumb.jpg` is NAMED AFTER its video. Renaming the video and leaving the
  // sidecar behind orphans it: the file keeps the old basename and now describes nothing,
  // while the renamed episode has no metadata beside it. We were dropping every one of
  // them as a "non-media file" — and tinyMediaManager, which writes these, moves them
  // with the video, so on a shared library we were quietly undoing its work.
  //
  // A sidecar is recognised STRUCTURALLY — its basename is the video's basename plus an
  // optional `-suffix` / `.suffix` — not by an extension allow-list, so `-thumb.jpg`,
  // `.nfo`, `-mediainfo.xml` and any future TMM sidecar all follow without enumeration.
  //
  // Show-level artwork is deliberately NOT matched and stays exactly where it is:
  // `poster.jpg`, `fanart.jpg`, `tvshow.nfo`, `season01-poster.jpg`, `theme.mp3` belong to
  // the FOLDER, not to any one episode. Moving them with an episode would be wrong, and is
  // why this matches on the video's basename rather than on "is it an image/xml".
  for (const f of ctx.files) {
    if (toDelete.has(f.path)) continue; // slated for cleanup
    const c = classifyFile(f.path, kind, sampleMax, f.size);
    if (c.kind !== 'general') continue; // videos/audio/subtitles already planned

    const base = path.basename(f.path, c.ext);

    // Longest matching video wins: with both "Show - S01E01" and "Show - S01E01 S01E02"
    // in a folder, a sidecar for the two-parter must not attach to the single episode.
    let best: { destNoExt: string } | null = null;
    let bestSuffix = '';
    let bestBaseLen = -1;
    for (const v of videoDest) {
      const vBase = path.basename(v.source, path.extname(v.source));
      if (!base.startsWith(vBase)) continue;
      const suffix = base.slice(vBase.length);
      // Either the same name, or the video's name plus a sidecar marker. A bare extra
      // character means it is a DIFFERENT file (e.g. "Episode 2" vs "Episode 20").
      if (suffix !== '' && !/^[-.]/.test(suffix)) continue;
      if (vBase.length > bestBaseLen) {
        best = v;
        bestSuffix = suffix;
        bestBaseLen = vBase.length;
      }
    }

    if (!best) {
      items.push({ source: f.path, destination: null, action: 'skip', kind: c.kind, reason: 'non-media file', skipped: true, isSubtitle: false, isSample: false, isExtra: c.isExtra });
      continue;
    }

    items.push({
      source: f.path,
      destination: `${best.destNoExt}${bestSuffix}${c.ext}`,
      action,
      kind: c.kind,
      reason: 'metadata sidecar (follows its video)',
      skipped: false,
      isSubtitle: false,
      isSample: false,
      isExtra: false,
    });
  }

  if (items.every((i) => i.skipped)) warnings.push('No renamable media files were found.');

  return { mode: ctx.mode, preset: ctx.preset, libraryPath: ctx.libraryPath, kind, parsed, items, warnings };
}

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
