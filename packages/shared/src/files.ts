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
}

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
