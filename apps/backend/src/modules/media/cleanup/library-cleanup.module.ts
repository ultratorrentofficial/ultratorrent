import { Module } from '@nestjs/common';
import { FilesModule } from '../../files/files.module';
import { ProtectionService } from './protection.service';
import { PolicyService } from './policy.service';
import { CandidateDiscoveryService } from './candidate-discovery.service';
import { PlanService } from './plan.service';
import { PlanExecutorService } from './plan-executor.service';
import { QuarantineService } from './quarantine.service';
import { CleanupSchedulerService } from './cleanup-scheduler.service';
import { CleanupJobBridge } from './cleanup-job.bridge';
import { CleanupController } from './cleanup.controller';

/**
 * Library Cleanup Center (module `library_cleanup`).
 *
 * A sibling of MediaModule rather than more providers inside it: MediaModule is
 * already 50+ providers and `@Global`, and this subsystem has its own boundary.
 * Prisma, Audit and the event bus are global; FilesModule/MediaModule are imported
 * where their services are needed (from Phase 8 onward, for the path-safe removal
 * and Trash seams — cleanup never touches the filesystem directly).
 */
@Module({
  // FilesModule supplies FilePathService (storage-scope confinement) and, from
  // Phase 8, FilesService/TrashService — cleanup never touches the filesystem itself.
  imports: [FilesModule],
  providers: [ProtectionService, PolicyService, CandidateDiscoveryService, PlanService, QuarantineService, PlanExecutorService, CleanupSchedulerService, CleanupJobBridge],
  controllers: [CleanupController],
  exports: [ProtectionService, PolicyService, CandidateDiscoveryService, PlanService, QuarantineService, PlanExecutorService, CleanupSchedulerService, CleanupJobBridge],
})
export class LibraryCleanupModule {}
