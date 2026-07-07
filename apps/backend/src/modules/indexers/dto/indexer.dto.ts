import { PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const IMPLEMENTATIONS = ['torznab', 'newznab'];
const PROTOCOLS = ['torrent', 'usenet'];

export class CreateIndexerDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsOptional() @IsIn(IMPLEMENTATIONS) implementation?: string;
  @IsOptional() @IsIn(PROTOCOLS) protocol?: string;
  @IsUrl({ require_tld: false }) @MaxLength(2048) baseUrl!: string;
  @IsOptional() @IsString() @MaxLength(512) apiKey?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(100) priority?: number;
  @IsOptional() @IsArray() @ArrayMaxSize(64) @IsInt({ each: true }) categories?: number[];
  @IsOptional() @IsInt() @Min(0) minSeeders?: number;
  @IsOptional() @IsInt() @Min(1000) @Max(120000) timeoutMs?: number;
}

export class UpdateIndexerDto extends PartialType(CreateIndexerDto) {}

export class TestSearchDto {
  @IsString() @MinLength(1) @MaxLength(300) q!: string;
  @IsOptional() @IsInt() @Min(0) season?: number;
  @IsOptional() @IsInt() @Min(0) ep?: number;
}
