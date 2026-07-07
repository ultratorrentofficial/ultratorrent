import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import configuration from './config/configuration';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { AuditModule } from './modules/audit/audit.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { EngineModule } from './modules/engine/engine.module';
import { AuthModule } from './modules/auth/auth.module';
import { TorrentsModule } from './modules/torrents/torrents.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { SettingsModule } from './modules/settings/settings.module';
import { UsersModule } from './modules/users/users.module';
import { TaxonomyModule } from './modules/taxonomy/taxonomy.module';
import { SearchModule } from './modules/search/search.module';
import { SystemModule } from './modules/system/system.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ApiKeysModule } from './modules/apikeys/apikeys.module';
import { FilesModule } from './modules/files/files.module';
import { RssModule } from './modules/rss/rss.module';
import { AutomationModule } from './modules/automation/automation.module';
import { TwoFactorModule } from './modules/two-factor/two-factor.module';
import { AccountModule } from './modules/account/account.module';
import { MediaModule } from './modules/media/media.module';
import { ModuleRegistryModule } from './modules/module-registry/module-registry.module';
import { ReleaseScoringModule } from './modules/release-scoring/release-scoring.module';
import { IndexersModule } from './modules/indexers/indexers.module';
import { MediaAcquisitionModule } from './modules/media-acquisition/media-acquisition.module';
import { MediaServerAnalyticsModule } from './modules/media-server-analytics/media-server-analytics.module';
import { NotificationCenterModule } from './modules/notification-center/notification-center.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot({ wildcard: true, delimiter: '.' }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),

    // Infrastructure & cross-cutting (global)
    PrismaModule,
    RealtimeModule,
    AuditModule,
    ModuleRegistryModule,
    NotificationsModule,
    EngineModule,
    MediaModule,
    AutomationModule,
    TwoFactorModule,

    // Feature modules
    AuthModule,
    AccountModule,
    UsersModule,
    TorrentsModule,
    DashboardModule,
    SettingsModule,
    TaxonomyModule,
    SearchModule,
    SystemModule,
    ApiKeysModule,
    FilesModule,
    RssModule,
    ReleaseScoringModule,
    IndexersModule,
    MediaAcquisitionModule,
    MediaServerAnalyticsModule,
    NotificationCenterModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
