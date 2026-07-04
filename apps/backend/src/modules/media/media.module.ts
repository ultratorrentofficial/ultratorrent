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
import { MediaArtworkService } from './media-artwork.service';
import { MediaSubtitleService } from './media-subtitle.service';
import { MediaNfoService } from './media-nfo.service';
import { MediaDuplicateService } from './media-duplicate.service';
import { MediaServerIntegrationService } from './media-server-integration.service';
import { MediaProcessingQueueService } from './media-processing-queue.service';
import { MediaAutomationActions } from './media-automation.actions';
import { MediaProcessingService } from './media-processing.service';
import { ImdbSettingsService } from './imdb/imdb-settings.service';
import { ImdbDatasetImporterService } from './imdb/imdb-dataset-importer.service';
import { ImdbService } from './imdb/imdb.service';
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
    MediaServerIntegrationService,
    MediaProcessingQueueService,
    MediaAutomationActions,
    MediaProcessingService,
    ImdbSettingsService,
    ImdbDatasetImporterService,
    ImdbService,
  ],
  controllers: [MediaController],
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
