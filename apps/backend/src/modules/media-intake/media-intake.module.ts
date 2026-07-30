import { Module } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { DomainEventsModule } from '../domain-events/domain-events.module';
import { EngineModule } from '../engine/engine.module';
import { MediaIntakeController } from './media-intake.controller';
import { MediaIntakeService } from './media-intake.service';
import { StorageProfileService } from './storage-profile.service';
import { PathMappingRegistryService } from './path-mapping-registry.service';
import { StorageCapabilityDetector } from './storage-capability-detector.service';
import { ImportStrategyService } from './import-strategy.service';
import { IntakeTriggerService } from './intake-trigger.service';

/**
 * The Media Intake Engine.
 *
 * Exports its services so the pipeline stages — which live where the work does,
 * next to metadata, artwork and subtitles — can drive an intake without this
 * module needing to import all of them back and create a cycle.
 */
@Module({
  imports: [PrismaModule, DomainEventsModule, EngineModule],
  controllers: [MediaIntakeController],
  providers: [
    MediaIntakeService,
    StorageProfileService,
    PathMappingRegistryService,
    StorageCapabilityDetector,
    ImportStrategyService,
    IntakeTriggerService,
  ],
  exports: [
    MediaIntakeService,
    StorageProfileService,
    PathMappingRegistryService,
    StorageCapabilityDetector,
    ImportStrategyService,
  ],
})
export class MediaIntakeModule {}
