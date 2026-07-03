import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  IsIn,
} from 'class-validator';

export class AddTorrentDto {
  @IsOptional()
  @IsString()
  magnet?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsString()
  engineId?: string;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsString()
  savePath?: string;

  @IsOptional()
  @IsBoolean()
  startPaused?: boolean;

  @IsOptional()
  @IsBoolean()
  sequentialDownload?: boolean;

  @IsOptional()
  @IsBoolean()
  firstLastPiecePriority?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  uploadLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  downloadLimit?: number;
}

export class BulkActionDto {
  @IsArray()
  @IsString({ each: true })
  hashes!: string[];

  @IsIn([
    'start',
    'stop',
    'pause',
    'resume',
    'recheck',
    'remove',
    'removeData',
  ])
  action!: string;

  @IsOptional()
  @IsString()
  engineId?: string;
}

export class SetLimitDto {
  @IsInt()
  @Min(0)
  bytesPerSec!: number;

  @IsOptional()
  @IsString()
  engineId?: string;
}

export class SetFilePriorityDto {
  @IsInt()
  @Min(0)
  fileIndex!: number;

  @IsIn([0, 1, 2])
  priority!: number;

  @IsOptional()
  @IsString()
  engineId?: string;
}

export class MoveStorageDto {
  @IsString()
  destination!: string;

  @IsOptional()
  @IsString()
  engineId?: string;
}

export class TrackerDto {
  // Trackers are http(s) or udp only — block javascript:/file:/gopher: etc.
  @IsString()
  @Matches(/^(https?|udp):\/\//i, { message: 'Tracker URL must be http(s) or udp' })
  url!: string;

  @IsOptional()
  @IsString()
  engineId?: string;
}
