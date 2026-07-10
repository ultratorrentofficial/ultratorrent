import { Global, Module } from '@nestjs/common';
import { EngineProviderFactory } from '../../infrastructure/engine/engine-provider.factory';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { EngineRegistryService } from './engine-registry.service';
import { EngineService } from './engine.service';
import { EngineController } from './engine.controller';

// SecretCipher is registered locally (it is not global), mirroring
// ProwlarrModule/IndexersModule — it encrypts engine credentials at rest.
@Global()
@Module({
  providers: [
    EngineProviderFactory,
    EngineRegistryService,
    EngineService,
    SecretCipher,
  ],
  controllers: [EngineController],
  exports: [EngineRegistryService, EngineService],
})
export class EngineModule {}
