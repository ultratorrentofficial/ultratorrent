import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { SecretCipher } from '../../common/crypto/secret-cipher';
import { MediaServerAnalyticsService } from './media-server-analytics.service';
import { MediaServerSessionService } from './media-server-session.service';
import { MediaServerReportService } from './media-server-report.service';
import { AnalyticsImportService } from './analytics-import.service';
import { MediaServerAnalyticsController } from './media-server-analytics.controller';

/**
 * Media Server Analytics (`media_server_analytics`). A core module that reuses
 * the Media Manager's media-server connections and provider layer to add server
 * monitoring, analytics, and (later) live activity, watch history, newsletters,
 * and Tautulli analytics import.
 */
@Module({
  imports: [MediaModule],
  providers: [MediaServerAnalyticsService, MediaServerSessionService, MediaServerReportService, AnalyticsImportService, SecretCipher],
  controllers: [MediaServerAnalyticsController],
})
export class MediaServerAnalyticsModule {}
