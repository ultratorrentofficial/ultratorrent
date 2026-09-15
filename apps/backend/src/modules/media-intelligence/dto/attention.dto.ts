import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

import {
  MEDIA_ATTENTION_VIEWS,
  MEDIA_FINDING_SEVERITIES,
  MEDIA_INTELLIGENCE_DOMAINS,
  MEDIA_INTELLIGENCE_ENTITY_TYPES,
} from '@ultratorrent/shared';

/**
 * Attention Center query and mutation contracts.
 *
 * Numeric params arrive as strings, matching the convention the rest of Media
 * Intelligence already uses. The global `ValidationPipe` runs with
 * `forbidNonWhitelisted`, so every accepted key must be declared here or the
 * request is rejected outright — which is also why the enumerated filters
 * validate against the shared vocabularies rather than free text.
 */

/**
 * The bulk ceiling.
 *
 * Deliberately local, matching how every other bulk endpoint in this codebase
 * declares its own (`MAX_BULK_IDS` 1000, `MAX_BULK_GROUPS` 100,
 * `MAX_BULK_JOBS` 200). 500 is sized for the real work: the measured active
 * queue is a few hundred findings, so "select everything on screen and
 * dismiss it" fits comfortably while a runaway client still hits a wall.
 */
export const MAX_ATTENTION_BULK = 500;

export class ListAttentionDto {
  @IsOptional() @IsString() @MaxLength(6) page?: string;
  @IsOptional() @IsString() @MaxLength(4) pageSize?: string;

  /** Which queue: active (default), snoozed, dismissed or resolved. */
  @IsOptional() @IsIn(MEDIA_ATTENTION_VIEWS as unknown as string[]) view?: string;

  @IsOptional() @IsIn(MEDIA_FINDING_SEVERITIES as unknown as string[]) severity?: string;
  @IsOptional() @IsIn(MEDIA_INTELLIGENCE_DOMAINS as unknown as string[]) domain?: string;
  @IsOptional() @IsString() @MaxLength(64) code?: string;
  @IsOptional() @IsIn(MEDIA_INTELLIGENCE_ENTITY_TYPES as unknown as string[]) entityType?: string;

  /** `'true'` for findings whose disposition the evaluator cleared. */
  @IsOptional() @IsString() @MaxLength(5) escalated?: string;

  /** Free-text search over the media title, resolved through the projection. */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
}

/** Acknowledge and dismiss: an optional note, never a demanded one. */
export class DispositionDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class SnoozeDto {
  /**
   * An absolute instant, not a duration.
   *
   * The client resolves "1 week" against the user's own display timezone and
   * sends the result; storing "next week" would leave the meaning of the row
   * dependent on who read it and when.
   */
  @IsISO8601() snoozedUntil!: string;

  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/** Bulk disposition. Ids are explicit — there is no "apply to whole query". */
export class BulkDispositionDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(MAX_ATTENTION_BULK)
  @IsString({ each: true })
  findingIds!: string[];

  @IsOptional() @IsString() @MaxLength(500) reason?: string;

  /** Required for a bulk snooze; ignored by the other verbs. */
  @IsOptional() @IsISO8601() snoozedUntil?: string;
}
