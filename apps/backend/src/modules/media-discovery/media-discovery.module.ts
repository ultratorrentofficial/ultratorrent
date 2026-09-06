import { Module, type OnModuleInit } from '@nestjs/common';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { SettingsModule, SettingsService } from '../settings/settings.module';
import { AuditModule } from '../audit/audit.module';
import { DiscoveryProviderRegistry } from './discovery-provider-registry.service';
import { DiscoveryStoreService } from './discovery-store.service';
import { DiscoverySyncService } from './discovery-sync.service';
import { DiscoveryTemplateService } from './discovery-template.service';
import { AcquisitionTemplateService } from './acquisition-template.service';
import { DiscoveryWatchlistService } from './discovery-watchlist.service';
import { MediaAcquisitionModule } from '../media-acquisition/media-acquisition.module';
import { TmdbDiscoveryProvider } from './tmdb-discovery.provider';
import { TvmazeDiscoveryProvider } from './tvmaze-discovery.provider';

export { TmdbDiscoveryProvider } from './tmdb-discovery.provider';
export { TvmazeDiscoveryProvider } from './tvmaze-discovery.provider';
export { evaluateDiscovery, categoriesMatch } from './discovery-policy';

/**
 * Media Discovery Engine.
 *
 * Discovers upcoming and new media, and decides what should be MONITORED —
 * handing everything else to the systems that already exist. An auto-monitored
 * title becomes a `MediaAcquisitionWatchlistItem` plus a generated `RssRule`, and
 * the existing acquisition sweeps and Smart Download engine make every download
 * decision from there.
 *
 * This module downloads nothing and scores no releases. If it ever appears to
 * need to, the answer is to call the acquisition engine, not to grow a second one.
 */
@Module({
  imports: [PrismaModule, SettingsModule, AuditModule, MediaAcquisitionModule],
  providers: [DiscoveryProviderRegistry, DiscoveryStoreService, DiscoverySyncService, DiscoveryTemplateService, AcquisitionTemplateService, DiscoveryWatchlistService],
  exports: [DiscoveryProviderRegistry, DiscoveryStoreService, DiscoverySyncService, DiscoveryTemplateService, AcquisitionTemplateService, DiscoveryWatchlistService],
})
export class MediaDiscoveryModule implements OnModuleInit {
  constructor(
    private readonly registry: DiscoveryProviderRegistry,
    private readonly settings: SettingsService,
  ) {}

  /**
   * Register the providers this installation can actually use.
   *
   * TMDB is registered only when a key exists — the same key the metadata
   * provider uses, so configuring TMDB once configures both. A provider that is
   * registered but unusable would report itself unhealthy on every sync and give
   * an operator a broken row to investigate that is really just "not configured".
   *
   * Registering is NOT enabling: `DiscoveryProviderState.enabled` defaults to
   * false, so nothing is called until an operator turns it on.
   */
  async onModuleInit(): Promise<void> {
    const tmdbKey =
      (await this.settings.get<string>('media.tmdbApiKey')) ?? process.env.TMDB_API_KEY ?? '';
    if (tmdbKey) this.registry.register(new TmdbDiscoveryProvider(tmdbKey));
    // TVmaze needs no credentials, so it is always available.
    this.registry.register(new TvmazeDiscoveryProvider());
  }
}
