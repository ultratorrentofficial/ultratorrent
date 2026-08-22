import { Module } from '@nestjs/common';
import { DashboardModule } from '../dashboard/dashboard.module';
import { DomainEventsModule } from '../domain-events/domain-events.module';
import { EngineModule } from '../engine/engine.module';
import { IndexersModule } from '../indexers/indexers.module';
import { ProwlarrIntegrationModule } from '../integrations/prowlarr/prowlarr.module';
import { JobsModule } from '../jobs/jobs.module';
import { MediaIntakeModule } from '../media-intake/media-intake.module';
import { MediaModule } from '../media/media.module';
import { MediaServerAnalyticsModule } from '../media-server-analytics/media-server-analytics.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SystemModule } from '../system/system.module';
import { TorrentSchedulerModule } from '../torrent-scheduler/torrent-scheduler.module';
import { TorrentsModule } from '../torrents/torrents.module';
import { OperationsController } from './operations.controller';
import { OperationsEventBridge } from './operations-event-bridge.service';
import { OperationsSnapshotService } from './operations-snapshot.service';

/**
 * The read-only aggregate surface UltraTorrent Console consumes.
 *
 * Every import below is here to READ a service that already owns its domain —
 * there is no repository, no scheduled task, no table and no cache of its own.
 * That is the module's defining constraint rather than an accident of its
 * current size: the moment it starts measuring something itself, the console
 * stops observing the platform and starts observing a second, quietly divergent
 * model of it.
 *
 * The long import list is the honest cost of that choice. The alternative —
 * querying other modules' tables directly — would be shorter here and wrong
 * everywhere else, because it would duplicate every projection rule those
 * services apply, redaction included.
 */
@Module({
  imports: [
    DashboardModule,
    SystemModule,
    EngineModule,
    TorrentsModule,
    TorrentSchedulerModule,
    MediaIntakeModule,
    MediaModule,
    MediaServerAnalyticsModule,
    JobsModule,
    IndexersModule,
    ProwlarrIntegrationModule,
    // The bridge's two sources: the catalogued bus, and the gateway it both
    // observes `jobs.*` on and re-emits to.
    DomainEventsModule,
    RealtimeModule,
  ],
  providers: [OperationsSnapshotService, OperationsEventBridge],
  controllers: [OperationsController],
})
export class OperationsModule {}
