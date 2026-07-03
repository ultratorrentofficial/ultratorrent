import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';
import {
  BulkOperationType,
  CleanupCategory,
  CLEANUP_CATEGORIES,
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
