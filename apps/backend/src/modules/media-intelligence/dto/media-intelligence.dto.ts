import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import {
  MEDIA_FINDING_SEVERITIES,
  MEDIA_HEALTH_STATUSES,
  MEDIA_INTELLIGENCE_DOMAINS,
  MEDIA_INTELLIGENCE_ENTITY_TYPES,
  MEDIA_QUALITY_STATUSES,
} from '@ultratorrent/shared';

/**
 * Query contract for the Media Health list.
 *
 * Numeric params arrive as strings and are coerced in the service, matching the
 * convention the duplicates list already uses — the global `ValidationPipe`
 * runs with `forbidNonWhitelisted`, so every accepted key must be declared here
 * or the request is rejected outright.
 *
 * The enumerated filters validate against the shared vocabularies rather than
 * free text, so an unknown health status or finding domain is a 400 instead of
 * a query that silently matches nothing.
 */
export const MEDIA_INTELLIGENCE_SORTS = [
  'health',
  'title',
  'size',
  'missing',
  'findings',
  'lastPlayed',
  'quality',
] as const;
export type MediaIntelligenceSort = (typeof MEDIA_INTELLIGENCE_SORTS)[number];

export class ListMediaIntelligenceDto {
  @IsOptional() @IsString() @MaxLength(6) page?: string;
  @IsOptional() @IsString() @MaxLength(4) pageSize?: string;

  /** Free-text title search. */
  @IsOptional() @IsString() @MaxLength(200) q?: string;

  @IsOptional() @IsIn(MEDIA_INTELLIGENCE_ENTITY_TYPES as unknown as string[]) entityType?: string;
  @IsOptional() @IsIn(MEDIA_HEALTH_STATUSES as unknown as string[]) health?: string;
  @IsOptional() @IsString() @MaxLength(64) libraryId?: string;

  /** Narrow to entities carrying an unresolved finding of this severity. */
  @IsOptional() @IsIn(MEDIA_FINDING_SEVERITIES as unknown as string[]) severity?: string;
  /** Narrow to entities carrying an unresolved finding in this domain. */
  @IsOptional() @IsIn(MEDIA_INTELLIGENCE_DOMAINS as unknown as string[]) domain?: string;
  /** `'true'` to show only entities with at least one unresolved finding. */
  @IsOptional() @IsString() @MaxLength(5) hasFindings?: string;

  /** Narrow to a quality-compliance verdict. */
  @IsOptional() @IsIn(MEDIA_QUALITY_STATUSES as unknown as string[]) quality?: string;
  /** `'true'` for entities where a more preferred rung exists. */
  @IsOptional() @IsString() @MaxLength(5) upgradePotential?: string;

  @IsOptional() @IsIn(MEDIA_INTELLIGENCE_SORTS as unknown as string[]) sort?: string;
  @IsOptional() @IsIn(['asc', 'desc']) direction?: string;
}

/** Path params for the per-entity endpoints. */
export class MediaIntelligenceEntityParamsDto {
  @IsIn(MEDIA_INTELLIGENCE_ENTITY_TYPES as unknown as string[]) entityType!: string;
  /** A season's id is composite (`showId:seasonNumber`), so this stays long. */
  @IsString() @MaxLength(128) entityId!: string;
}

export class ListFindingsDto {
  @IsOptional() @IsIn(MEDIA_FINDING_SEVERITIES as unknown as string[]) severity?: string;
  @IsOptional() @IsIn(MEDIA_INTELLIGENCE_DOMAINS as unknown as string[]) domain?: string;
  /** `'true'` includes findings that have already been resolved. */
  @IsOptional() @IsString() @MaxLength(5) includeResolved?: string;
}
