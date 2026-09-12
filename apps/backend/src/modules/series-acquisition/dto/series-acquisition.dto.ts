import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

import { SERIES_ACQUISITION_MODES, type SeriesAcquisitionMode } from '../series-acquisition-provisioning.service';

/** Shared body for both the dry-run plan and the provisioning call. */
export class SeriesAcquisitionDto {
  @IsString() title!: string;

  @IsOptional() @IsInt() year?: number;

  /** External ids, identity-first (imdb/tmdb/tvdb/tvmaze/trakt). */
  @IsOptional() @IsObject() externalIds?: Record<string, string>;

  @IsOptional() @IsString() mediaType?: string;

  @IsIn(SERIES_ACQUISITION_MODES) mode!: SeriesAcquisitionMode;

  /** Seasons to acquire; omit/empty = all. */
  @IsOptional() @IsArray() @IsInt({ each: true }) @Min(0, { each: true }) seasons?: number[];

  /** Explicit confirmation to monitor an ended/canceled show. */
  @IsOptional() @IsBoolean() allowInactiveShowMonitoring?: boolean;

  @IsOptional() @IsString() templateId?: string | null;

  @IsOptional() @IsString() targetLibraryId?: string | null;
}

export class SeriesSearchDto {
  @IsString() q!: string;
  @IsOptional() @IsInt() year?: number;
}
