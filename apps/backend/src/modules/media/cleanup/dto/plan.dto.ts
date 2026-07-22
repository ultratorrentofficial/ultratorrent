import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsIn, IsInt,
  IsOptional, IsString, Max, MaxLength, Min,
} from 'class-validator';

/**
 * A plan is built from CANDIDATE IDS produced by a run — never from paths and never
 * from media file ids supplied by the browser. The server resolves every path
 * itself from the run's own snapshot, so a request body cannot name a file the
 * policy never matched.
 */
export class CreatePlanDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  candidateIds!: string[];

  /**
   * Optional and only ever a DOWNGRADE. Absent means the policy's own destination.
   * A request may soften `trash` to `quarantine`; it can never escalate.
   */
  @IsOptional() @IsIn(['quarantine', 'trash'])
  destination?: string;

  /** Trash/quarantine retention. Absent means the policy's value. */
  @IsOptional() @IsInt() @Min(1) @Max(3650)
  retentionDays?: number;

  /** How long the plan may wait for a decision before its snapshot is too old. */
  @IsOptional() @IsInt() @Min(1) @Max(720)
  expiresInHours?: number;

  /** Why this cleanup is being proposed. Recorded on the plan and in the audit log. */
  @IsOptional() @IsString() @MaxLength(500)
  notes?: string;
}

export class RejectPlanDto {
  /** Required: an unexplained rejection teaches the next operator nothing. */
  @IsString() @MaxLength(500)
  reason!: string;
}

export class CancelPlanDto {
  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}

export class PlanListQueryDto {
  @IsOptional() @IsInt() @Min(1) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(200) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(64) runId?: string;
  @IsOptional() @IsIn([
    'draft', 'pending_approval', 'approved', 'rejected', 'executing',
    'completed', 'partial', 'failed', 'expired', 'cancelled',
  ])
  status?: string;
}

export class ActionListQueryDto {
  @IsOptional() @IsInt() @Min(1) page?: number;
  @IsOptional() @IsInt() @Min(1) @Max(200) pageSize?: number;
  @IsOptional() @IsIn(['pending', 'running', 'completed', 'failed', 'skipped', 'compensated'])
  status?: string;
}
