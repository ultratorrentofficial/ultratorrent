import { Module } from '@nestjs/common';
import { SecretCipher } from '../../../common/crypto/secret-cipher';
import { ProwlarrController } from './prowlarr.controller';
import { ProwlarrIntegrationService } from './prowlarr.service';

/**
 * Prowlarr companion integration. PrismaService/AuditService are @Global;
 * SecretCipher is registered locally (it is not global), mirroring IndexersModule.
 */
@Module({
  providers: [ProwlarrIntegrationService, SecretCipher],
  controllers: [ProwlarrController],
  exports: [ProwlarrIntegrationService],
})
export class ProwlarrIntegrationModule {}
