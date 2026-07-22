import {
  ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional,
  IsString, Max, MaxLength, Min,
} from 'class-validator';
import type { CleanupPolicyDocument } from '../domain/policy-document';

export class CreatePolicyDto {
  @IsString() @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;
}

export class UpdatePolicyDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() @MaxLength(200) scheduleCron?: string;
  @IsOptional() @IsInt() @Min(1) @Max(99) freeSpaceTriggerPercent?: number;
}

export class SavePolicyDraftDto {
  /** Deep-validated by the domain validator, not class-validator. */
  @IsObject()
  document!: CleanupPolicyDocument;

  @IsOptional() @IsString() @MaxLength(2000)
  changeNotes?: string;
}

export class ValidatePolicyDto {
  @IsObject()
  document!: CleanupPolicyDocument;
}

export class PublishPolicyDto {
  @IsOptional() @IsString() @MaxLength(2000)
  changeNotes?: string;
}

export class PolicyListQueryDto {
  @IsOptional() @IsInt() @Min(1) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(200) pageSize?: number;
  @IsOptional() @IsIn(['draft', 'validation_failed', 'ready', 'published', 'disabled', 'archived']) status?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
}

export class SimulatePolicyDto {
  /** Optional document override; otherwise the policy's draft/published document. */
  @IsOptional() @IsObject()
  document?: CleanupPolicyDocument;

  /** Cap the sample the simulation walks. */
  @IsOptional() @IsInt() @Min(1) @Max(5000)
  limit?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true })
  libraryIds?: string[];
}
