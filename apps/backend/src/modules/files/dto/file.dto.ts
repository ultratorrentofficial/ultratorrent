import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  BulkOperationType,
  CleanupCategory,
  CLEANUP_CATEGORIES,
  ConflictResolution,
} from '@ultratorrent/shared';

/** A single root-relative path (browse/preview/download/properties/delete). */
export class PathDto {
  @IsString() path!: string;
}

export class CreateFolderDto {
  /** Parent directory (root-relative). */
  @IsString() path!: string;
  @IsString() name!: string;
}

/** Set the file-browser Default Root Path (an absolute server path). */
export class SetRootPathDto {
  @IsString() path!: string;
}

export class RenameFileDto {
  @IsString() path!: string;
  @IsString() newName!: string;
  @IsOptional() @IsBoolean() overwrite?: boolean;
}

export class MoveFileDto {
  @IsString() source!: string;
  /** Destination DIRECTORY (root-relative); final path is destination/basename. */
  @IsString() destination!: string;
  @IsOptional() @IsBoolean() overwrite?: boolean;
}

export class CopyFileDto {
  @IsString() source!: string;
  /** Destination DIRECTORY (root-relative). */
  @IsString() destination!: string;
  @IsOptional() @IsBoolean() overwrite?: boolean;
}

export class DeleteFileDto {
  @IsString() path!: string;
  /** When true, permanently delete; otherwise move to Trash (default). */
  @IsOptional() @IsBoolean() permanent?: boolean;
}

export class BulkOperationDto {
  @IsIn(['move', 'copy', 'delete', 'cleanup'])
  operation!: BulkOperationType;

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  paths!: string[];

  /** Destination directory for move/copy (root-relative). */
  @IsOptional() @IsString() destination?: string;
  @IsOptional() @IsBoolean() overwrite?: boolean;
  @IsOptional() @IsBoolean() permanent?: boolean;
}

/** Ask what a planned move/copy would collide with. Read-only. */
export class MoveConflictPreflightDto {
  @IsIn(['move', 'copy'])
  operation!: 'move' | 'copy';

  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  sources!: string[];

  /** Destination directory (root-relative). */
  @IsString() destination!: string;
}

/** One decided conflict. `targetPath` comes from the preflight report. */
export class ConflictResolutionItemDto {
  @IsString() source!: string;

  @IsIn(['replace', 'keep_both', 'delete_source', 'skip'])
  resolution!: ConflictResolution;

  @IsOptional() @IsString() targetPath?: string;
}

/** Carry out the operator's decisions from a conflict report. */
export class ResolveConflictsDto {
  @IsIn(['move', 'copy'])
  operation!: 'move' | 'copy';

  /** Destination directory (root-relative). */
  @IsString() destination!: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => ConflictResolutionItemDto)
  items!: ConflictResolutionItemDto[];

  /** Hard-delete instead of routing displaced files through Trash. */
  @IsOptional() @IsBoolean() permanent?: boolean;
}

export class CleanupPreviewDto {
  /** Folder to scan (root-relative). */
  @IsString() path!: string;

  @IsOptional()
  @IsArray()
  @IsIn(CLEANUP_CATEGORIES, { each: true })
  categories?: CleanupCategory[];
}

export class CleanupExecuteDto {
  /** Folder that was scanned (root-relative). */
  @IsString() path!: string;

  /** Selected candidate paths to remove (root-relative). */
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  paths!: string[];

  @IsOptional() @IsBoolean() permanent?: boolean;
}

export class TrashRestoreDto {
  @IsString() id!: string;
  @IsOptional() @IsBoolean() overwrite?: boolean;
}

export type { BulkOperationType };
