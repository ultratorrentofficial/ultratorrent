import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

import {
  MEDIA_INTELLIGENCE_ENTITY_TYPES,
  REMEDIATION_PLAN_STATUSES,
} from '@ultratorrent/shared';

/**
 * Remediation plan contracts.
 *
 * The global `ValidationPipe` runs with `forbidNonWhitelisted`, so every
 * accepted key must be declared here or the request is rejected outright.
 * Enumerated filters validate against the shared vocabularies rather than
 * free text, so an unknown status is a 400 instead of a query that silently
 * matches nothing.
 *
 * Note what a client may NOT send anywhere below: no step, no capability id,
 * no owner domain, no path. The server decides what a plan does; a request
 * may only decide *whether* it proceeds.
 */
export class ListRemediationPlansDto {
  @IsOptional() @IsString() @MaxLength(6) page?: string;
  @IsOptional() @IsString() @MaxLength(4) pageSize?: string;

  /** Defaults to the active queue: decided plans are history. */
  @IsOptional() @IsIn(REMEDIATION_PLAN_STATUSES as unknown as string[]) status?: string;

  @IsOptional()
  @IsIn(MEDIA_INTELLIGENCE_ENTITY_TYPES as unknown as string[])
  entityType?: string;

  @IsOptional() @IsString() @MaxLength(64) entityId?: string;
  @IsOptional() @IsString() @MaxLength(64) policyId?: string;

  /** Free-text search over the media title, resolved through the projection. */
  @IsOptional() @IsString() @MaxLength(200) q?: string;
}

/**
 * Cancelling a plan.
 *
 * The reason is optional, matching Library Cleanup: cancelling is often
 * housekeeping ("not now"), and demanding a justification for it would train
 * operators to type a full stop.
 */
export class CancelRemediationPlanDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

/**
 * Rejecting a plan outright.
 *
 * The reason is REQUIRED here, and the asymmetry with cancel is deliberate —
 * lifted from Library Cleanup, whose DTO says it plainly: an unexplained
 * rejection teaches the next operator nothing, and the next operator is
 * usually the same person six weeks later.
 */
export class RejectRemediationPlanDto {
  @IsString() @MaxLength(500) reason!: string;
}
