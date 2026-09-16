import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';

import {
  LIFECYCLE_COMPLETENESS_INTENTS,
  LIFECYCLE_POLICY_MODES,
  LIFECYCLE_QUALITY_INTENTS,
  LIFECYCLE_SCOPE_TYPES,
} from '@ultratorrent/shared';

/**
 * Lifecycle policy contracts.
 *
 * The global `ValidationPipe` runs with `forbidNonWhitelisted`, so every
 * accepted key must be declared here or the request is rejected outright.
 * The enumerated fields validate against the shared vocabularies rather than
 * free text, which is also what keeps `automatic` from being accepted as a
 * mode: it is not in `LIFECYCLE_POLICY_MODES`, and Phase 5 has no executor.
 *
 * Note what is deliberately absent from the update DTO's semantics: there is
 * no way to express "unset this dimension" distinctly from "leave it alone",
 * because the service resolves that by merging against the stored row. A
 * caller clears a dimension by sending `null`, which the service stores as
 * NULL — "says nothing, inherit".
 */
export class CreateLifecyclePolicyDto {
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;

  @IsOptional() @IsIn(LIFECYCLE_SCOPE_TYPES as unknown as string[]) scopeType?: string;
  @IsOptional() @IsString() @MaxLength(200) scopeId?: string;

  @IsOptional() @IsIn(LIFECYCLE_POLICY_MODES as unknown as string[]) mode?: string;

  @IsOptional() @IsIn(LIFECYCLE_QUALITY_INTENTS as unknown as string[]) quality?: string;
  @IsOptional() @IsIn(LIFECYCLE_COMPLETENESS_INTENTS as unknown as string[]) completeness?: string;

  /** Bounded: a language list is a handful of codes, never a payload. */
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  subtitleLanguages?: string[];

  @IsOptional() @IsObject() acquisition?: Record<string, unknown>;
}

/** Every field optional; the service merges against the stored row. */
export class UpdateLifecyclePolicyDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;

  @IsOptional() @IsIn(LIFECYCLE_SCOPE_TYPES as unknown as string[]) scopeType?: string;
  @IsOptional() @IsString() @MaxLength(200) scopeId?: string;

  @IsOptional() @IsIn(LIFECYCLE_POLICY_MODES as unknown as string[]) mode?: string;

  @IsOptional() @IsIn(LIFECYCLE_QUALITY_INTENTS as unknown as string[]) quality?: string;
  @IsOptional() @IsIn(LIFECYCLE_COMPLETENESS_INTENTS as unknown as string[]) completeness?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  subtitleLanguages?: string[];

  @IsOptional() @IsObject() acquisition?: Record<string, unknown>;
}
