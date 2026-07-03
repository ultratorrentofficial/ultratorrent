import { Global, Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { FilesModule } from '../files/files.module';
import { MediaService } from './media.service';
import { MediaLibraryService } from './media-library.service';
import { MediaScannerService } from './media-scanner.service';
import { MediaIdentificationService } from './media-identification.service';
import { MediaItemService } from './media-item.service';
import { MediaHealthService } from './media-health.service';
import { MediaController } from './media.controller';

/**
 * Media Manager — scan, identify, enrich, and organise media libraries.
 *
 * Evolved from the original media renamer: it keeps the pure rename engine
 * (preview/apply/presets/history) and adds library scanning, filename-based
 * identification, item management, and a health dashboard. Filesystem access is
 * constrained by FilePathService (imported from FilesModule).
 */
@Global()
@Module({
  imports: [SettingsModule, FilesModule],
  providers: [
    MediaService,
    MediaLibraryService,
    MediaScannerService,
    MediaIdentificationService,
    MediaItemService,
    MediaHealthService,
  ],
  controllers: [MediaController],
  exports: [
    MediaService,
    MediaLibraryService,
    MediaScannerService,
    MediaIdentificationService,
    MediaItemService,
    MediaHealthService,
  ],
})
export class MediaModule {}
