import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import {
  ALL_MEDIA_RECOMMENDATION_TYPES,
  MEDIA_INTELLIGENCE_ENTITY_TYPES,
  MEDIA_RECOMMENDATION_CLASSES,
  MEDIA_RECOMMENDATION_CONFIDENCE,
  MEDIA_RECOMMENDATION_STATUSES,
  MEDIA_VERIFICATION_STATUSES,
} from '@ultratorrent/shared';

/**
 * Recommendation query contracts.
 *
 * Numeric params arrive as strings, matching the convention the rest of Media
 * Intelligence uses. The global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so every accepted key must be declared here or the
 * request is rejected outright — which is also why the enumerated filters
 * validate against the shared vocabularies rather than free text.
 */
export class ListRecommendationsDto {
  @IsOptional() @IsString() @MaxLength(6) page?: string;
  @IsOptional() @IsString() @MaxLength(4) pageSize?: string;

  /** Defaults to `active`: history does not belong in a queue of work. */
  @IsOptional() @IsIn(MEDIA_RECOMMENDATION_STATUSES as unknown as string[]) status?: string;

  @IsOptional() @IsIn(ALL_MEDIA_RECOMMENDATION_TYPES as unknown as string[]) type?: string;
  @IsOptional()
  @IsIn(MEDIA_RECOMMENDATION_CLASSES as unknown as string[])
  recommendationClass?: string;
  @IsOptional() @IsIn(MEDIA_RECOMMENDATION_CONFIDENCE as unknown as string[]) confidence?: string;
  @IsOptional() @IsIn(MEDIA_VERIFICATION_STATUSES as unknown as string[]) verification?: string;
  @IsOptional()
  @IsIn(MEDIA_INTELLIGENCE_ENTITY_TYPES as unknown as string[])
  entityType?: string;

  /** `'true'` for recommendations something can actually be done about. */
  @IsOptional() @IsString() @MaxLength(5) actionable?: string;

  /** Free-text search over the media title, resolved through the projection. */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
}
