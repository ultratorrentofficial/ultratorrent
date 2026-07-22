import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class RunListQueryDto {
  @IsOptional() @IsInt() @Min(1) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(200) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(64) policyId?: string;
  @IsOptional() @IsIn(['queued', 'running', 'waiting_for_approval', 'completed', 'partial', 'failed', 'cancelling', 'cancelled'])
  status?: string;
}

export class CandidateListQueryDto {
  @IsOptional() @IsInt() @Min(1) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(200) pageSize?: number;
  /** Default: only actionable candidates. Pass a status to inspect exclusions. */
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsIn(['rank', 'size', 'path']) sort?: string;
}
