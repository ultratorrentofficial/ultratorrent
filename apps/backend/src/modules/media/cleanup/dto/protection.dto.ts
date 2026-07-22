import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsObject,
  IsOptional, IsString, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export const PROTECTION_TARGET_TYPES = [
  'media_file', 'media_item', 'show', 'season', 'episode', 'library',
  'path_prefix', 'tag', 'collection', 'watchlist', 'torrent', 'external_identity',
] as const;

export const PROTECTION_TYPES = ['permanent', 'temporary', 'conditional', 'legal_hold'] as const;

export const PROTECTION_CONDITION_KINDS = [
  'on_watchlist', 'partially_watched', 'torrent_ratio_below',
  'recently_added', 'job_active', 'until_all_watched',
] as const;

export class CreateProtectionDto {
  @IsIn(PROTECTION_TARGET_TYPES as unknown as string[])
  targetType!: string;

  @IsIn(PROTECTION_TYPES as unknown as string[])
  protectionType!: string;

  /** Why this exists. Required — an unexplained protection is unauditable. */
  @IsString() @MaxLength(500)
  reason!: string;

  @IsOptional() @IsString() @MaxLength(64) mediaItemId?: string;
  @IsOptional() @IsString() @MaxLength(64) mediaFileId?: string;
  @IsOptional() @IsString() @MaxLength(64) mediaShowId?: string;
  @IsOptional() @IsString() @MaxLength(64) mediaLibraryId?: string;
  @IsOptional() @IsInt() @Min(0) @Max(1000) seasonNumber?: number;
  @IsOptional() @IsInt() @Min(0) @Max(10000) episodeNumber?: number;
  @IsOptional() @IsString() @MaxLength(200) externalIdentityKey?: string;
  @IsOptional() @IsString() @MaxLength(1024) pathPrefix?: string;
  @IsOptional() @IsString() @MaxLength(128) tagValue?: string;
  @IsOptional() @IsString() @MaxLength(64) collectionId?: string;
  @IsOptional() @IsString() @MaxLength(64) torrentHash?: string;

  /** temporary only. */
  @IsOptional() @IsDateString()
  protectedUntil?: string;

  /** conditional only. */
  @IsOptional() @IsIn(PROTECTION_CONDITION_KINDS as unknown as string[])
  conditionKind?: string;

  @IsOptional() @IsObject()
  conditionConfig?: Record<string, unknown>;
}

export class BulkCreateProtectionDto {
  @IsArray() @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => CreateProtectionDto)
  protections!: CreateProtectionDto[];
}

export class RevokeProtectionDto {
  @IsString() @MaxLength(500)
  reason!: string;
}

export class ProtectionListQueryDto {
  @IsOptional() @IsInt() @Min(1) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(200) pageSize?: number;
  @IsOptional() @IsIn(PROTECTION_TARGET_TYPES as unknown as string[]) targetType?: string;
  @IsOptional() @IsIn(PROTECTION_TYPES as unknown as string[]) protectionType?: string;
  /** Default true — the registry's useful view is what is currently protecting. */
  @IsOptional() @IsBoolean() activeOnly?: boolean;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
}

export class ExpiringQueryDto {
  @IsOptional() @IsInt() @Min(1) @Max(365)
  withinDays?: number;
}
