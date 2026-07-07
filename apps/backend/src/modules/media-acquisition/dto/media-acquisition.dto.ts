import { PartialType } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const WATCHLIST_TYPES = ['series', 'season', 'episode', 'movie', 'movie_collection', 'anime', 'manual_query'];
const DECISIONS = ['download', 'skip', 'hold_for_approval', 'upgrade_existing', 'replace_existing', 'manual_review'];

export class CreateWatchlistItemDto {
  @IsIn(WATCHLIST_TYPES) type!: string;
  @IsString() @MinLength(1) @MaxLength(300) title!: string;
  @IsOptional() @IsInt() year?: number;
  @IsOptional() @IsObject() externalIds?: Record<string, unknown>;
  @IsOptional() @IsInt() seasonNumber?: number;
  @IsOptional() @IsInt() episodeNumber?: number;
  @IsOptional() @IsString() @MaxLength(300) collectionName?: string;
  @IsOptional() @IsIn(['active', 'paused', 'completed', 'archived']) status?: string;
  @IsOptional() @IsInt() @Min(0) priority?: number;
  @IsOptional() @IsString() profileId?: string;
  @IsOptional() @IsString() targetLibraryId?: string;
  @IsOptional() @IsObject() settings?: Record<string, unknown>;
}
export class UpdateWatchlistItemDto extends PartialType(CreateWatchlistItemDto) {}

export class BulkAddSeriesItemDto {
  @IsString() @MinLength(1) @MaxLength(300) title!: string;
  @IsOptional() @IsInt() year?: number | null;
  @IsOptional() @IsString() @MaxLength(30) imdbId?: string | null;
}
export class BulkAddWatchlistDto {
  @IsArray() series!: BulkAddSeriesItemDto[];
}

export class CreateAcquisitionProfileDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsIn(['tv', 'movie', 'anime', 'any']) mediaType!: string;
  @IsOptional() @IsInt() @Min(0) minimumScore?: number;
  @IsOptional() @IsInt() @Min(0) approvalScore?: number;
  @IsOptional() @IsString() minimumResolution?: string;
  @IsOptional() @IsString() preferredResolution?: string;
  @IsOptional() @IsString() preferredSource?: string;
  @IsOptional() @IsString() preferredCodec?: string;
  @IsOptional() @IsString() preferredAudio?: string;
  @IsOptional() @IsString() preferredHdr?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) preferredLanguages?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) requiredTerms?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) excludedTerms?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) preferredGroups?: string[];
  @IsOptional() @IsObject() qualityRules?: Record<string, unknown>;
  @IsOptional() @IsObject() duplicateRules?: Record<string, unknown>;
  @IsOptional() @IsObject() storageRules?: Record<string, unknown>;
  @IsOptional() @IsObject() automationRules?: Record<string, unknown>;
  @IsOptional() @IsBoolean() enabled?: boolean;
}
export class UpdateAcquisitionProfileDto extends PartialType(CreateAcquisitionProfileDto) {}

export class EvaluateReleaseDto {
  @IsString() @MinLength(1) @MaxLength(1024) releaseName!: string;
  @IsOptional() @IsString() @MaxLength(40) sourceType?: string;
  @IsOptional() @IsString() sourceId?: string;
  @IsOptional() @IsString() profileId?: string;
  @IsOptional() @IsInt() @Min(0) sizeBytes?: number;
  @IsOptional() @IsInt() @Min(0) seeders?: number;
  /** magnet:/.torrent URL. When present, an auto (non-approval) decision downloads. */
  @IsOptional() @IsString() @MaxLength(8192) downloadUrl?: string;
  @IsOptional() @IsString() @MaxLength(1024) savePath?: string;
}

export class RejectEvaluationDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class OverrideEvaluationDto {
  @IsIn(DECISIONS) decision!: string;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class ExportAcquisitionDataDto {
  @IsOptional() @IsBoolean() evaluations?: boolean;
  @IsOptional() @IsBoolean() watchlist?: boolean;
  @IsOptional() @IsBoolean() profiles?: boolean;
}
