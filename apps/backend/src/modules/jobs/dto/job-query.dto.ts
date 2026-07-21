import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, ArrayMaxSize, Max, Min, MaxLength } from 'class-validator';
import { JOB_STATUSES } from '../platform/job-status';

const SORT_FIELDS = ['createdAt', 'queuedAt', 'startedAt', 'completedAt', 'priority', 'status'] as const;

/** Filter/sort/paginate the platform job list. All optional; server enforces caps. */
export class JobListQueryDto {
  @IsOptional() @IsInt() @Min(1)
  page?: number;

  @IsOptional() @IsInt() @Min(1) @Max(200)
  pageSize?: number;

  @IsOptional() @IsIn(JOB_STATUSES)
  status?: string;

  /** Only active (queued/running/waiting/blocked/…) jobs. */
  @IsOptional() @IsBoolean()
  active?: boolean;

  @IsOptional() @IsString() @MaxLength(64)
  moduleKey?: string;

  @IsOptional() @IsString() @MaxLength(64)
  workspaceKey?: string;

  @IsOptional() @IsString() @MaxLength(128)
  type?: string;

  @IsOptional() @IsIn(['manual', 'scheduled', 'event', 'automation', 'workflow', 'system'])
  source?: string;

  @IsOptional() @IsString() @MaxLength(64)
  createdById?: string;

  @IsOptional() @IsString() @MaxLength(128)
  correlationId?: string;

  @IsOptional() @IsString() @MaxLength(64)
  libraryId?: string;

  @IsOptional() @IsString() @MaxLength(64)
  resourceId?: string;

  /** Free-text: matches name, type, id, or correlation id. */
  @IsOptional() @IsString() @MaxLength(200)
  search?: string;

  @IsOptional() @IsIn(SORT_FIELDS)
  sort?: (typeof SORT_FIELDS)[number];

  @IsOptional() @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';
}

/** Paginate/filter a job's structured events. */
export class JobEventsQueryDto {
  @IsOptional() @IsInt() @Min(1)
  page?: number;

  @IsOptional() @IsInt() @Min(1) @Max(200)
  pageSize?: number;

  @IsOptional() @IsIn(['debug', 'info', 'warning', 'error', 'success'])
  level?: string;
}

/** A bulk action over selected jobs (bounded to keep requests safe). */
export class BulkJobActionDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  jobIds!: string[];
}
