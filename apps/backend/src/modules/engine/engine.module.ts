import { Global, Module } from '@nestjs/common';
import { EngineProviderFactory } from '../../infrastructure/engine/engine-provider.factory';
import { EngineRegistryService } from './engine-registry.service';
import { EngineService } from './engine.service';
import { EngineController } from './engine.controller';

@Global()
@Module({
  providers: [EngineProviderFactory, EngineRegistryService, EngineService],
  controllers: [EngineController],
  exports: [EngineRegistryService, EngineService],
})
export class EngineModule {}
