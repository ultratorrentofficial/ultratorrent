import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { DomainEventsModule } from '../domain-events/domain-events.module';
import { EngineModule } from '../engine/engine.module';
import { MediaModule } from '../media/media.module';
import { MediaIntakeController } from './media-intake.controller';
import { MediaIntakeService } from './media-intake.service';
import { StorageProfileService } from './storage-profile.service';
import { IntakeMigrationService } from './intake-migration.service';
import { PathMappingRegistryService } from './path-mapping-registry.service';
import { StorageCapabilityDetector } from './storage-capability-detector.service';
import { ImportStrategyService } from './import-strategy.service';
import { IntakeTriggerService } from './intake-trigger.service';
import { IntakePipelineService } from './intake-pipeline.service';
import { IntakeStagesService } from './intake-stages.service';
import { IntakePostImportService } from './intake-post-import.service';

/**
 * The Media Intake Engine.
 *
 * Exports its services so the pipeline stages — which live where the work does,
 * next to metadata, artwork and subtitles — can drive an intake without this
 * module needing to import all of them back and create a cycle.
 */
@Module({
  imports: [PrismaModule, DomainEventsModule, EngineModule, MediaModule],
  controllers: [MediaIntakeController],
  providers: [
    MediaIntakeService,
    StorageProfileService,
    IntakeMigrationService,
    PathMappingRegistryService,
    StorageCapabilityDetector,
    ImportStrategyService,
    IntakeTriggerService,
    IntakePipelineService,
    IntakeStagesService,
    IntakePostImportService,
  ],
  exports: [
    MediaIntakeService,
    StorageProfileService,
    IntakeMigrationService,
    PathMappingRegistryService,
    StorageCapabilityDetector,
    ImportStrategyService,
    IntakePipelineService,
  ],
})
export class MediaIntakeModule {}
