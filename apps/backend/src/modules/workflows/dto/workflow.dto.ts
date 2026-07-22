import {
  IsArray, IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min, ArrayMaxSize,
} from 'class-validator';
import type { WorkflowGraph } from '../domain/workflow-graph.types';

export class CreateWorkflowDto {
  @IsString() @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsString() @MaxLength(64)
  workspaceKey?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) @MaxLength(48, { each: true })
  tags?: string[];
}

export class UpdateWorkflowDto {
  @IsOptional() @IsString() @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsString() @MaxLength(64)
  workspaceKey?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(32) @IsString({ each: true }) @MaxLength(48, { each: true })
  tags?: string[];
}

export class SaveDraftGraphDto {
  /** The full workflow graph. Deep-validated by the domain validator, not class-validator. */
  @IsObject()
  graph!: WorkflowGraph;

  @IsOptional() @IsString() @MaxLength(2000)
  changeNotes?: string;
}

export class ValidateGraphDto {
  @IsObject()
  graph!: WorkflowGraph;
}

export class PublishWorkflowDto {
  @IsOptional() @IsString() @MaxLength(2000)
  changeNotes?: string;
}

export class RunWorkflowDto {
  /** Trigger payload for this manual run. */
  @IsOptional() @IsObject()
  context?: Record<string, unknown>;
}

export class SimulateWorkflowDto {
  /** Optional graph override; when omitted the workflow's current draft/published graph is used. */
  @IsOptional() @IsObject()
  graph?: WorkflowGraph;

  /** Sample trigger payload the simulated run receives. */
  @IsOptional() @IsObject()
  trigger?: Record<string, unknown>;

  /** Seed variables for the simulation. */
  @IsOptional() @IsObject()
  vars?: Record<string, unknown>;
}

export class WorkflowListQueryDto {
  @IsOptional() @IsInt() @Min(1)
  page?: number;

  @IsOptional() @IsInt() @Min(1) @Max(200)
  pageSize?: number;

  @IsOptional() @IsIn(['draft', 'validation_failed', 'ready', 'published', 'disabled', 'archived'])
  status?: string;

  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsString() @MaxLength(64)
  workspaceKey?: string;

  @IsOptional() @IsString() @MaxLength(200)
  search?: string;
}
