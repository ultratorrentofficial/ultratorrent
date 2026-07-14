import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { FilesModule } from '../files/files.module';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { MediaService } from './media.service';
import { MediaLibraryService } from './media-library.service';
import { MediaScannerService } from './media-scanner.service';
import { MediaIdentificationService } from './media-identification.service';
import { MediaItemService } from './media-item.service';
import { MediaHealthService } from './media-health.service';
import { MediaMetadataService } from './media-metadata.service';
import { MetadataProviderRegistry } from './metadata-provider-registry.service';
import { MediaArtworkService } from './media-artwork.service';
import { MediaSubtitleService } from './media-subtitle.service';
import { MediaNfoService } from './media-nfo.service';
import { MediaDuplicateService } from './media-duplicate.service';
import { MediaShowDuplicateService } from './media-show-duplicate.service';
import { MediaServerIntegrationService } from './media-server-integration.service';
import { MediaProcessingQueueService } from './media-processing-queue.service';
import { MediaAutomationActions } from './media-automation.actions';
import { TraktAuthService } from './trakt/trakt-auth.service';
import { TraktSyncService } from './trakt/trakt-sync.service';
import { TraktScrobbleService } from './trakt/trakt-scrobble.service';
import { TraktController } from './trakt/trakt.controller';
import { MediaProcessingService } from './media-processing.service';
import { MediaLibraryScanScheduler } from './media-library-scan-scheduler.service';
import { MediaServerHealthScheduler } from './media-server-health-scheduler.service';
import { MediaProbeService } from './media-probe.service';
import { MediaProbeBackfillService } from './media-probe-backfill.service';
import { ImdbSettingsService } from './imdb/imdb-settings.service';
import { ImdbDatasetImporterService } from './imdb/imdb-dataset-importer.service';
import { ImdbOptimizedImportService } from './imdb/imdb-optimized-import.service';
import { ImdbDatasetScheduler } from './imdb/imdb-dataset-scheduler.service';
import { ImdbService } from './imdb/imdb.service';
import { ImdbTrigramIndexService } from './imdb/imdb-trigram-index.service';
import { MediaController } from './media.controller';

/**
 * Media Manager — scan, identify, enrich, and organise media libraries.
 *
 * Keeps the pure rename engine (preview/apply/presets/history) and layers on
 * library scanning, filename-based identification, metadata/artwork/subtitle
 * enrichment, Kodi NFO generation, duplicate detection, and media-server
 * integrations (Plex/Jellyfin/Emby/Kodi). Filesystem access is constrained by
 * FilePathService (from FilesModule); integration secrets are encrypted at rest
 * with SecretCipher.
 */
@Global()
@Module({
  imports: [SettingsModule, FilesModule],
  providers: [
    ImdbTrigramIndexService,
    MetadataProviderRegistry,
    TraktAuthService,
    TraktSyncService,
    TraktScrobbleService,
    SecretCipher,
    MediaService,
    MediaLibraryService,
    MediaScannerService,
    MediaIdentificationService,
    MediaItemService,
    MediaHealthService,
    MediaMetadataService,
    MediaArtworkService,
    MediaSubtitleService,
    MediaNfoService,
    MediaDuplicateService,
    MediaShowDuplicateService,
    MediaServerIntegrationService,
    MediaProcessingQueueService,
    MediaAutomationActions,
    MediaProcessingService,
    MediaLibraryScanScheduler,
    MediaServerHealthScheduler,
    MediaProbeService,
    MediaProbeBackfillService,
    ImdbSettingsService,
    ImdbDatasetImporterService,
    ImdbOptimizedImportService,
    ImdbDatasetScheduler,
    ImdbService,
  ],
  controllers: [MediaController, TraktController],
  exports: [
    MediaService,
    MediaLibraryService,
    MediaScannerService,
    MediaIdentificationService,
    MediaItemService,
    MediaHealthService,
    MediaMetadataService,
    MediaArtworkService,
    MediaSubtitleService,
    MediaNfoService,
    MediaDuplicateService,
    MediaServerIntegrationService,
    MediaProcessingQueueService,
    MediaAutomationActions,
    MediaProcessingService,
    ImdbSettingsService,
    ImdbDatasetImporterService,
    ImdbService,
  ],
})
export class MediaModule {}
