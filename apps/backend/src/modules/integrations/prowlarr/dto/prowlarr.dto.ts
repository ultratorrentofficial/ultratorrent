import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Partial update of the Prowlarr companion settings. URLs are validated in the
 * service (scheme + no-credentials) rather than here so that an empty string can
 * mean "reset to the configured default" and the same guard covers the test DTO.
 */
export class UpdateProwlarrSettingsDto {
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsString() @MaxLength(2048) internalUrl?: string;
  @IsOptional() @IsString() @MaxLength(2048) publicUrl?: string;
  @IsOptional() @IsString() @MaxLength(512) apiKey?: string;
}

/**
 * Test a connection using either the saved settings or ad-hoc values entered in
 * the form before saving (mirrors how the indexers page tests inline). A masked
 * or blank apiKey falls back to the stored key.
 */
export class TestProwlarrDto {
  @IsOptional() @IsString() @MaxLength(2048) internalUrl?: string;
  @IsOptional() @IsString() @MaxLength(512) apiKey?: string;
}
