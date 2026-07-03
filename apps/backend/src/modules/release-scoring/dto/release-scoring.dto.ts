import { Type } from 'class-transformer';
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
  ValidateNested,
} from 'class-validator';

export class ScoreDto {
  @IsString() @MaxLength(1024) title!: string;
  @IsOptional() @IsString() @MaxLength(20) preferredResolution?: string;
  @IsOptional() @IsString() @MaxLength(20) preferredCodec?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) preferredSources?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) preferredGroups?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) avoidedGroups?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) excludedTerms?: string[];
  @IsOptional() @IsInt() @Min(0) seeders?: number;
  @IsOptional() @IsIn(['healthy', 'degraded', 'dead']) trackerHealth?: string;
  @IsOptional() @IsBoolean() duplicateRisk?: boolean;
}

export class TestRuleDto {
  @IsString() @MaxLength(1024) title!: string;
  @IsObject() rule!: Record<string, unknown>;
}
