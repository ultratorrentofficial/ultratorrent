import { Module } from '@nestjs/common';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { IndexerService } from './indexer.service';
import { TorznabClient } from './torznab-client';
import { IndexersController } from './indexers.controller';

/**
 * Torznab/Newznab indexer subsystem: CRUD + capability testing + release search.
 * Exports {@link IndexerService} so the media-acquisition bridge can search for
 * missing-episode releases. PrismaService/AuditService are @Global; SecretCipher
 * is registered locally (it is not global).
 */
@Module({
  providers: [IndexerService, TorznabClient, SecretCipher],
  controllers: [IndexersController],
  exports: [IndexerService],
})
export class IndexersModule {}
