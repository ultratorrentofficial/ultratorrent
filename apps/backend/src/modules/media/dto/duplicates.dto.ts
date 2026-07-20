import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/** Group lifecycle. `open` is anything awaiting a decision. */
export const DUPLICATE_STATUSES = ['open', 'ignored', 'resolved'] as const;

/** What kind of thing is duplicated. These resolve completely differently. */
export const DUPLICATE_GROUP_TYPES = ['file', 'show_folder'] as const;

export const DUPLICATE_REASONS = [
  'external_id',
  'show_season_episode',
  'title_year',
  'similar_filename',
] as const;

/**
 * Sort orders offered by the Duplicate Center.
 *
 * `needs_review` is the default rather than a raw list order: the whole point of the
 * redesign is that the first screen shows what needs a decision, not an
 * undifferentiated dump. It sorts review-required groups first, then by the storage
 * they could reclaim.
 */
export const DUPLICATE_SORTS = [
  'needs_review',
  'savings_desc',
  'confidence_desc',
  'confidence_asc',
  'files_desc',
  'recent',
  'oldest',
  'title',
] as const;

export class ListDuplicatesDto {
  @IsOptional() @IsString() @MaxLength(4) page?: string;
  @IsOptional() @IsString() @MaxLength(4) pageSize?: string;

  /** Free-text over media title and file path. */
  @IsOptional() @IsString() @MaxLength(200) q?: string;

  @IsOptional() @IsString() @MaxLength(64) libraryId?: string;
  @IsOptional() @IsString() @MaxLength(32) mediaType?: string;

  @IsOptional() @IsIn(DUPLICATE_STATUSES as unknown as string[]) status?: string;
  @IsOptional() @IsIn(DUPLICATE_GROUP_TYPES as unknown as string[]) groupType?: string;
  @IsOptional() @IsIn(DUPLICATE_REASONS as unknown as string[]) reason?: string;
  @IsOptional() @IsIn(DUPLICATE_SORTS as unknown as string[]) sort?: string;

  /** `'true'` restricts to groups that must not be cleaned automatically. */
  @IsOptional() @IsString() @MaxLength(5) requiresReview?: string;
}

export class IgnoreDuplicateGroupDto {
  /**
   * Why this is not a duplicate. Optional but strongly encouraged — an ignore with
   * no reason is indistinguishable from a mistake six months later.
   */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class ResolveDuplicateDto {
  /**
   * Which copy to keep. Optional when the group carries a recommendation; REQUIRED
   * when it needs review, because the engine deliberately withholds a recommendation
   * there and inventing one at preview time would defeat the point.
   */
  @IsOptional() @IsString() @MaxLength(64) keepItemId?: string;
}
