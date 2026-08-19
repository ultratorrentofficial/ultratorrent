/**
 * File-manager contracts shared by the backend Files module and the frontend
 * File Browser. Engine-agnostic; no Node or DOM types leak in here.
 */

/** A single entry returned by the browse endpoint. Paths are root-relative. */
export interface FileNode {
  name: string;
  /** Root-relative path (always starts with `/`). */
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string | null;
}

export interface BrowseResponse {
  path: string;
  /** Absolute allowed roots (display only). */
  roots: string[];
  items: FileNode[];
}

/** Extended metadata for the Properties dialog. */
export interface FilePropertiesResponse {
  name: string;
  path: string;
  /** Absolute on-disk path (admin/debug visibility). */
  absolutePath: string;
  isDirectory: boolean;
  size: number;
  /** For directories: recursive item count + byte total. */
  itemCount?: number;
  extension: string | null;
  createdAt: string | null;
  modifiedAt: string | null;
  /** sha-256 of the file contents when cheap to compute (files ≤ hashLimit). */
  hash: string | null;
  /** Parsed media metadata when the name/extension is recognizable. */
  media?: Record<string, unknown> | null;
}

/** The mutating file operations the module supports. */
export type FileOperationType =
  | 'create_folder'
  | 'rename'
  | 'move'
  | 'copy'
  | 'delete'
  | 'bulk'
  | 'cleanup'
  | 'restore'
  | 'trash_empty';

/** Whether a delete routes through Trash or is permanent. */
export type DeleteMode = 'trash' | 'permanent';

/** Bulk action kinds. */
export type BulkOperationType = 'move' | 'copy' | 'delete' | 'cleanup';

// --- Cleanup ---------------------------------------------------------------

export const CLEANUP_CATEGORIES = [
  'sample_files',
  'empty_folders',
  'zero_byte_files',
  'duplicate_files',
  'orphan_subtitles',
  'orphan_artwork',
  'nfo_files',
  'sfv_files',
  'txt_files',
  'hidden_temp_files',
  'partial_downloads',
] as const;

export type CleanupCategory = (typeof CLEANUP_CATEGORIES)[number];

/** Human-friendly labels for each cleanup category. */
export const CLEANUP_CATEGORY_LABELS: Record<CleanupCategory, string> = {
  sample_files: 'Sample files',
  empty_folders: 'Empty folders',
  zero_byte_files: 'Zero-byte files',
  duplicate_files: 'Duplicate files',
  orphan_subtitles: 'Orphan subtitles',
  orphan_artwork: 'Orphan artwork',
  nfo_files: 'NFO files',
  sfv_files: 'SFV files',
  txt_files: 'TXT files',
  hidden_temp_files: 'Hidden / temporary files',
  partial_downloads: 'Partial downloads',
};

export interface CleanupCandidate {
  /** Root-relative path of the candidate. */
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
  category: CleanupCategory;
  /** Why this item was flagged (surfaced verbatim in the preview UI). */
  reason: string;
}

export interface CleanupCategoryGroup {
  category: CleanupCategory;
  label: string;
  itemCount: number;
  totalSize: number;
  items: CleanupCandidate[];
}

export interface CleanupPreview {
  /** Root-relative root that was scanned. */
  root: string;
  categories: CleanupCategoryGroup[];
  totalItems: number;
  totalSize: number;
  /** Bytes recoverable if every candidate is removed. */
  estimatedSpaceSaved: number;
}

export interface CleanupExecuteResult {
  removed: number;
  failed: number;
  bytesReclaimed: number;
  mode: DeleteMode;
}

// --- Trash -----------------------------------------------------------------

export interface TrashItemDto {
  id: string;
  name: string;
  /** Original root-relative path before deletion. */
  originalPath: string;
  isDirectory: boolean;
  size: number;
  deletedAt: string;
  deletedBy: string | null;
  /**
   * When the retention sweep will permanently delete this item, or `null` when
   * retention is disabled (`files.trashRetentionDays` = 0) and it is kept until
   * someone purges it by hand.
   *
   * Sent as an absolute instant rather than a remaining-seconds number so the UI
   * can tick a countdown down locally without re-polling, and so a stale response
   * cannot make an expired item look like it still has time left.
   */
  expiresAt: string | null;
}

/** Settings key holding the Trash retention window, in days. `0` disables pruning. */
export const TRASH_RETENTION_DAYS_KEY = 'files.trashRetentionDays';

/** Retention window applied when the setting is unset. */
export const DEFAULT_TRASH_RETENTION_DAYS = 30;

// --- Move/copy conflict analysis ------------------------------------------

/**
 * What a planned move/copy would collide with in the destination.
 *
 * `identical` and `same_episode` are deliberately distinct: the first means the
 * bytes are already there (so the source is redundant), the second means the
 * *episode* is already there in a different release (so it is a judgement call
 * about which release to keep). Everything else that merely shares a filename is
 * `name_clash`, where nothing can be inferred about content.
 */
export type ConflictKind = 'identical' | 'same_episode' | 'name_clash';

/**
 * What to do about one conflict.
 * - `replace`      — target out of the way, source takes its place.
 * - `keep_both`    — land the source alongside the target (renamed if needed).
 * - `delete_source`— keep the target, don't transfer, dispose of the source.
 * - `skip`         — leave both files exactly as they are.
 */
export type ConflictResolution = 'replace' | 'keep_both' | 'delete_source' | 'skip';

/** How `identical` was concluded — surfaced so the UI never overstates it. */
export type IdentityBasis = 'size+partial-hash';

/** One side of a conflict, with whatever the release name gave up. */
export interface ConflictFileInfo {
  /** Root-relative path. */
  path: string;
  name: string;
  size: number;
  modifiedAt: string | null;
  show: string | null;
  season: number | null;
  episode: number | null;
  resolution: string | null;
  source: string | null;
  codec: string | null;
  releaseGroup: string | null;
  proper: boolean;
  repack: boolean;
}

/** Which release is better, from the operator's point of view. */
export type QualityVerdict = 'source_better' | 'target_better' | 'equivalent' | 'unknown';

export interface MoveConflict {
  source: ConflictFileInfo;
  /** The file already in the destination that the source collides with. */
  target: ConflictFileInfo;
  kind: ConflictKind;
  /** Present only when `kind` is `identical`. */
  identityBasis?: IdentityBasis;
  verdict: QualityVerdict;
  /** Human-readable dimensions the winner wins on, e.g. "resolution 1080p > 720p". */
  verdictReasons: string[];
  /** Pre-selected in the UI. Never destructive unless the evidence is unambiguous. */
  recommended: ConflictResolution;
  /** Resolutions that make sense for this kind, in display order. */
  allowed: ConflictResolution[];
}

export interface MoveConflictReport {
  /** Root-relative destination directory. */
  destination: string;
  conflicts: MoveConflict[];
  /** Sources with nothing in their way — these need no decision. */
  clean: string[];
}

/** One decided conflict, sent back to be carried out. */
export interface ConflictResolutionInput {
  source: string;
  resolution: ConflictResolution;
  /** The colliding file, as reported by the preflight. Required for `replace`. */
  targetPath?: string;
}

// --- Operation result + WS payloads ---------------------------------------

export interface FileOperationResult {
  operation: FileOperationType;
  ok: boolean;
  /** Root-relative path the operation produced (where applicable). */
  path?: string;
  itemCount?: number;
  bytes?: number;
  message?: string;
}

export interface FileOperationEventPayload {
  operation: FileOperationType;
  /** Root-relative source/target path(s). */
  source?: string;
  destination?: string;
  itemCount?: number;
  bytes?: number;
  result?: 'success' | 'failure';
  message?: string;
  at: string;
}

// --- Preview / streaming ---------------------------------------------------

/**
 * What a file can be *shown as*, decided from its name alone.
 *
 * The File Manager used to have exactly one answer — "read it as UTF-8 text and
 * print it in a `<pre>`" — which turned a JPEG into mojibake and an MKV into a
 * 256 KB truncation error. The kind is what the preview surface branches on, so
 * both ends agree on it here rather than each keeping its own extension list.
 */
export type FilePreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'subtitle'
  | 'nfo'
  | 'text'
  | 'pdf'
  | 'archive'
  | 'binary';

/**
 * Extension → kind. Lower-case, no leading dot.
 *
 * `nfo` is deliberately its own kind rather than `text`: a scene NFO is CP437
 * ASCII art whose alignment only survives a monospace, non-wrapping, correctly
 * decoded viewer — the plain-text reader mangles it.
 */
const PREVIEW_KIND_BY_EXTENSION: Record<string, FilePreviewKind> = {
  // image
  jpg: 'image', jpeg: 'image', jfif: 'image', png: 'image', gif: 'image',
  webp: 'image', bmp: 'image', avif: 'image', svg: 'image', ico: 'image',
  tif: 'image', tiff: 'image', heic: 'image', heif: 'image',
  // video
  mp4: 'video', m4v: 'video', mkv: 'video', webm: 'video', avi: 'video',
  mov: 'video', mpg: 'video', mpeg: 'video', wmv: 'video', flv: 'video',
  ts: 'video', m2ts: 'video', mts: 'video', ogv: 'video', '3gp': 'video',
  divx: 'video', vob: 'video',
  // audio
  mp3: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio',
  opus: 'audio', wav: 'audio', m4a: 'audio', wma: 'audio', aiff: 'audio',
  aif: 'audio', ape: 'audio', mka: 'audio',
  // subtitle
  srt: 'subtitle', vtt: 'subtitle', ass: 'subtitle', ssa: 'subtitle',
  sub: 'subtitle', smi: 'subtitle', sbv: 'subtitle',
  // nfo
  nfo: 'nfo', diz: 'nfo',
  // text
  txt: 'text', log: 'text', md: 'text', json: 'text', xml: 'text', csv: 'text',
  yml: 'text', yaml: 'text', ini: 'text', conf: 'text', cfg: 'text',
  sfv: 'text', cue: 'text', m3u: 'text', m3u8: 'text', url: 'text',
  html: 'text', htm: 'text', css: 'text', js: 'text', sh: 'text', py: 'text',
  // document
  pdf: 'pdf',
  // archive
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive',
  gz: 'archive', bz2: 'archive', xz: 'archive', iso: 'archive',
};

/** MIME type per extension, for the kinds the browser renders natively. */
const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff',
  heic: 'image/heic', heif: 'image/heif',
  /*
   * SVG is a script-bearing document, not an inert bitmap. It is served with its
   * real type so the viewer can render it, and the stream route pairs that type
   * with `Content-Security-Policy: default-src 'none'; sandbox` — inside an
   * `<img>` the browser already refuses to run its scripts, and the CSP covers
   * the one case `<img>` does not: someone navigating straight at the URL.
   */
  svg: 'image/svg+xml',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', ts: 'video/mp2t', m2ts: 'video/mp2t',
  mts: 'video/mp2t', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  aiff: 'audio/aiff', aif: 'audio/aiff', mka: 'audio/x-matroska',
  pdf: 'application/pdf',
};

/**
 * Containers a browser will reliably play from a plain `<video>`/`<audio>`.
 *
 * Everything else (MKV, AVI, WMV, FLAC-in-MKV…) still gets a player — codec
 * support varies by browser and a Matroska with H.264/AAC usually does play in
 * Chrome — but the UI warns first instead of showing a silent black rectangle.
 */
const RELIABLY_PLAYABLE = new Set([
  'mp4', 'm4v', 'webm', 'ogv', 'mp3', 'ogg', 'oga', 'opus', 'wav', 'm4a', 'flac',
]);

/** Lower-case extension without the dot, or `''` when the name has none. */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

/** How this file should be presented. Name-only — never touches the bytes. */
export function filePreviewKind(name: string): FilePreviewKind {
  return PREVIEW_KIND_BY_EXTENSION[fileExtension(name)] ?? 'binary';
}

/**
 * MIME type to serve/expect for a file, or `application/octet-stream` when the
 * extension is unknown or deliberately withheld (see the SVG note above).
 */
export function filePreviewMime(name: string): string {
  return MIME_BY_EXTENSION[fileExtension(name)] ?? 'application/octet-stream';
}

/** Whether the browser is likely to decode this container without help. */
export function isReliablyPlayable(name: string): boolean {
  return RELIABLY_PLAYABLE.has(fileExtension(name));
}

/** Kinds served as bytes from the stream route rather than inlined as text. */
export function isStreamableKind(kind: FilePreviewKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf';
}

/**
 * Text encodings the preview can decode into.
 *
 * `cp437` is here for NFO files: they predate Unicode and their box-drawing art
 * is only meaningful under the original DOS code page. `latin1` is the common
 * fallback for European subtitle files that were never UTF-8.
 */
export type PreviewTextEncoding = 'utf-8' | 'cp437' | 'latin1' | 'utf-16le' | 'utf-16be';

export const PREVIEW_TEXT_ENCODINGS: readonly PreviewTextEncoding[] = [
  'utf-8', 'cp437', 'latin1', 'utf-16le', 'utf-16be',
] as const;

/** What the preview endpoint reports for one file. */
export interface FilePreviewResponse {
  /** Root-relative path. */
  path: string;
  name: string;
  size: number;
  kind: FilePreviewKind;
  /** MIME the stream route will serve, when the kind is streamable. */
  mime: string;
  /** True when the bytes come from `/files/stream` rather than `content`. */
  streamable: boolean;
  /** Decoded text for text-ish kinds; `null` for streamed or unreadable kinds. */
  content: string | null;
  /** Which encoding produced `content`. */
  encoding: PreviewTextEncoding | null;
  /** Encoding the server detected before any caller override. */
  detectedEncoding: PreviewTextEncoding | null;
  /** `content` stops at the read limit — the file continues past it. */
  truncated: boolean;
  /** Set when nothing could be shown, with the reason (e.g. an archive). */
  reason: string | null;
}

/**
 * A short-lived, single-path grant that lets a plain `<img>`/`<video>` element
 * fetch bytes it cannot attach a bearer token to.
 *
 * Scoped to one path so a leaked URL exposes that file and nothing else.
 */
export interface MediaTicket {
  token: string;
  /** The root-relative path this ticket authorises, as the server resolved it. */
  path: string;
  /** ISO instant the ticket stops being accepted. */
  expiresAt: string;
}
