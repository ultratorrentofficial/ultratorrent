import { Global, Module } from '@nestjs/common';
import { EngineProviderFactory } from '../../infrastructure/engine/engine-provider.factory';
import { ProviderWatchService } from './provider-watch.service';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { EngineRegistryService } from './engine-registry.service';
import { EngineService } from './engine.service';
import { EngineController } from './engine.controller';
import { EngineStatusTracker } from './engine-status.tracker';
import { EngineTorrentCache } from './engine-torrent.cache';

// SecretCipher is registered locally (it is not global), mirroring
// ProwlarrModule/IndexersModule — it encrypts engine credentials at rest.
@Global()
@Module({
  providers: [
    ProviderWatchService,
    EngineProviderFactory,
    EngineRegistryService,
    EngineService,
    EngineStatusTracker,
    EngineTorrentCache,
    SecretCipher,
  ],
  controllers: [EngineController],
  exports: [EngineRegistryService, EngineService, EngineStatusTracker, EngineTorrentCache],
})
export class EngineModule {}
