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
