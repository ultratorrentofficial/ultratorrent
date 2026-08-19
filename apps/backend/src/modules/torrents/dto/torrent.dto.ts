import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
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

  /**
   * Hand this download to Media Intake when it finishes, staged under this
   * profile. Set by the "Managed intake" mode in the Add Torrent dialog.
   *
   * When present the profile's staging root REPLACES `savePath` — see
   * `TorrentsService.add`. The two are not both honoured on purpose: an intake
   * that stages into a library folder is the failure this mode exists to make
   * impossible, and silently accepting a contradictory path is how it would
   * come back.
   */
  @IsOptional()
  @IsString()
  intakeProfileId?: string;

  /**
   * Optional folder BENEATH the profile's staging root to download into, e.g.
   * `manual` or `manual/4k`. Relative on purpose: the staging root is the
   * profile's to decide, and this only says where inside it this release waits
   * for the pipeline. Ignored — refused, actually — without `intakeProfileId`,
   * since the standard path already has `savePath`.
   *
   * It does not change where the release is IMPORTED: that is still the
   * profile's library for whatever the release turns out to be.
   */
  @IsOptional()
  @IsString()
  @MaxLength(255)
  intakeSubfolder?: string;

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

  /**
   * With `removeData`, also delete what these torrents imported into a library.
   * Only meaningful for that action; ignored otherwise.
   */
  @IsOptional()
  @IsBoolean()
  removeLibrary?: boolean;
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
