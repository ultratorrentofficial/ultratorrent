import { Global, Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { JobRegistry } from './platform/job-registry.service';
import { PlatformJobService } from './platform/platform-job.service';

/**
 * The Unified Jobs Center module. Provides:
 *  - the legacy read-only aggregator (`JobsService` / `GET /api/jobs`), and
 *  - the platform job engine (`JobRegistry` + `PlatformJobService`) — the normalized
 *    job contract every module registers into.
 *
 * `@Global` so any module can inject `JobRegistry` (to register its job definitions)
 * and `PlatformJobService` (to enqueue/run jobs) without importing this module —
 * matching how the platform's other cross-cutting services (Prisma, Audit) are wired,
 * and keeping the Jobs Center decoupled from concrete module services (review §15.2).
 */
@Global()
@Module({
  providers: [JobsService, JobRegistry, PlatformJobService],
  controllers: [JobsController],
  exports: [JobsService, JobRegistry, PlatformJobService],
})
export class JobsModule {}
