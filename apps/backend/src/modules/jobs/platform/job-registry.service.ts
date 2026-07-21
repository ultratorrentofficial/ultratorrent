import { Injectable, Logger } from '@nestjs/common';
import type { JobDefinition, JobHandler, RegisteredJob } from './job.types';

/** Thrown when a job type is registered twice. */
export class DuplicateJobRegistrationError extends Error {
  constructor(type: string) {
    super(`Job type "${type}" is already registered`);
    this.name = 'DuplicateJobRegistrationError';
  }
}

/** Thrown when work references a job type no module registered. */
export class UnknownJobTypeError extends Error {
  constructor(type: string) {
    super(`Unknown job type "${type}"`);
    this.name = 'UnknownJobTypeError';
  }
}

/**
 * The single place modules declare job capabilities. A module registers a
 * {@link JobDefinition} + {@link JobHandler} for each type it owns; the platform
 * looks handlers up by type at execution time. The Jobs Center reads only this
 * normalized metadata — it never imports concrete module services (review §15.2).
 *
 * Registration is validated: duplicate types are rejected, and a definition must
 * declare its `type`, `moduleKey`, and `labelKey`. Registry is populated at module
 * init by each owning module (so ownership is implicit and local).
 */
@Injectable()
export class JobRegistry {
  private readonly logger = new Logger(JobRegistry.name);
  private readonly entries = new Map<string, RegisteredJob>();

  register<TInput, TResult>(
    definition: JobDefinition<TInput, TResult>,
    handler: JobHandler<TInput, TResult>,
  ): void {
    const { type, moduleKey, labelKey } = definition;
    if (!type || !moduleKey || !labelKey) {
      throw new Error(
        `Invalid job definition: type, moduleKey and labelKey are required (got type=${type ?? '∅'})`,
      );
    }
    if (this.entries.has(type)) throw new DuplicateJobRegistrationError(type);
    this.entries.set(type, {
      definition: definition as JobDefinition,
      handler: handler as JobHandler,
    });
    this.logger.log(`Registered job type "${type}" (module ${moduleKey})`);
  }

  has(type: string): boolean {
    return this.entries.has(type);
  }

  /** Look up a registered job by type; throws {@link UnknownJobTypeError} if absent. */
  get(type: string): RegisteredJob {
    const entry = this.entries.get(type);
    if (!entry) throw new UnknownJobTypeError(type);
    return entry;
  }

  getDefinition(type: string): JobDefinition {
    return this.get(type).definition;
  }

  /** The full catalog of registered definitions (for `/api/jobs/catalog`). */
  list(): JobDefinition[] {
    return [...this.entries.values()].map((e) => e.definition);
  }

  /** Registered definitions for a given module. */
  listByModule(moduleKey: string): JobDefinition[] {
    return this.list().filter((d) => d.moduleKey === moduleKey);
  }

  get size(): number {
    return this.entries.size;
  }
}
