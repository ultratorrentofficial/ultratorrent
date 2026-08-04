import { Module, type OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { EngineModule } from '../engine/engine.module';
import { AuditModule } from '../audit/audit.module';
import { SettingsModule } from '../settings/settings.module';
import { DomainEventsModule } from '../domain-events/domain-events.module';
import { SchedulerCapabilityService } from './scheduler-capability.service';
import { SchedulerPreviewService } from './scheduler-preview.service';
import { SchedulerSweepService } from './scheduler-sweep.service';
import { SchedulerModeService } from './scheduler-mode.service';
import { SchedulerReconciliationService } from './scheduler-reconciliation.service';
import { SchedulerActivationService } from './scheduler-activation.service';
import { SchedulerPolicyService } from './scheduler-policy.service';
import { SchedulerOverrideService } from './scheduler-override.service';
import { CapabilityRegistry } from '../context-actions/capability-registry.service';
import { SCHEDULER_ACTIONS } from './scheduler-actions';
import { TorrentSchedulerController } from './torrent-scheduler.controller';

/**
 * The Torrent Activity Scheduler.
 *
 * One cohesive module rather than a scatter of tiny ones. Its imports are the
 * whole story of what it can reach: Prisma for its own tables and the existing
 * torrent snapshots, the engine registry to enumerate engines and read their
 * kind, and audit for the one mutation it has.
 *
 * `SchedulerReconciliationService` is the one part that CAN change a torrent,
 * and nothing reaches it: the sweep calls it only for `managed` mode, and
 * `SchedulerModeService` refuses to set that mode. The machinery is built and
 * tested a phase before anything can run it, so enabling enforcement later is a
 * change to one guard rather than the arrival of untested behaviour.
 */
@Module({
  imports: [PrismaModule, EngineModule, AuditModule, SettingsModule, DomainEventsModule],
  providers: [
    SchedulerCapabilityService,
    SchedulerPreviewService,
    SchedulerSweepService,
    SchedulerModeService,
    SchedulerReconciliationService,
    SchedulerActivationService,
    SchedulerPolicyService,
    SchedulerOverrideService,
  ],
  controllers: [TorrentSchedulerController],
  exports: [SchedulerPreviewService, SchedulerCapabilityService, SchedulerOverrideService],
})
/** Contributes the scheduler's instructions to the CAMA registry at boot. */
export class TorrentSchedulerModule implements OnModuleInit {
  constructor(private readonly capabilities: CapabilityRegistry) {}

  onModuleInit(): void {
    this.capabilities.registerAll(SCHEDULER_ACTIONS);
  }
}
