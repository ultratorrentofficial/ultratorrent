import { Global, Module } from '@nestjs/common';
import { ModuleRegistryModule } from '../module-registry/module-registry.module';
import { CapabilityRegistry } from './capability-registry.service';
import { ContextActionService } from './context-action.service';
import { ContextActionsController } from './context-actions.controller';

/**
 * Context-Aware Management Actions.
 *
 * `@Global` for the same reason `JobsModule` is: any module must be able to
 * contribute actions from its own `onModuleInit` without every module in the
 * graph importing this one, and an import edge from twenty modules into a
 * registry is how dependency cycles start.
 *
 * Note the direction of dependency — modules depend on the registry to
 * *declare*; the registry never depends on them. It knows nothing about media,
 * torrents or jobs, which is what lets a new module contribute actions without
 * anything here changing.
 */
@Global()
@Module({
  imports: [ModuleRegistryModule],
  controllers: [ContextActionsController],
  providers: [CapabilityRegistry, ContextActionService],
  exports: [CapabilityRegistry, ContextActionService],
})
export class ContextActionsModule {}
