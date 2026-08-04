import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { EngineModule } from '../engine/engine.module';
import { AuditModule } from '../audit/audit.module';
import { SchedulerCapabilityService } from './scheduler-capability.service';
import { SchedulerPreviewService } from './scheduler-preview.service';
import { SchedulerSweepService } from './scheduler-sweep.service';
import { SchedulerModeService } from './scheduler-mode.service';
import { TorrentSchedulerController } from './torrent-scheduler.controller';

/**
 * The Torrent Activity Scheduler.
 *
 * One cohesive module rather than a scatter of tiny ones. Its imports are the
 * whole story of what it can reach: Prisma for its own tables and the existing
 * torrent snapshots, the engine registry to enumerate engines and read their
 * kind, and audit for the one mutation it has.
 *
 * Note what is absent. Nothing here can pause or resume a torrent — the module
 * never touches `TorrentsService`, and the sweep holds no provider reference at
 * all. Observe Only is a property of the wiring, not a rule someone has to
 * remember while editing.
 */
@Module({
  imports: [PrismaModule, EngineModule, AuditModule],
  providers: [
    SchedulerCapabilityService,
    SchedulerPreviewService,
    SchedulerSweepService,
    SchedulerModeService,
  ],
  controllers: [TorrentSchedulerController],
  exports: [SchedulerPreviewService, SchedulerCapabilityService],
})
export class TorrentSchedulerModule {}
