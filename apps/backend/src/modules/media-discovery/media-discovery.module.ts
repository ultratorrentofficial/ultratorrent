import { Module } from '@nestjs/common';
import { DiscoveryProviderRegistry } from './discovery-provider-registry.service';
export { TmdbDiscoveryProvider } from './tmdb-discovery.provider';
export { TvmazeDiscoveryProvider } from './tvmaze-discovery.provider';

/**
 * Media Discovery Engine.
 *
 * Discovers upcoming and new media, decides what should be MONITORED, and hands
 * everything else to the systems that already exist: an auto-monitored title
 * becomes a `MediaAcquisitionWatchlistItem` plus a generated `RssRule`, and the
 * existing acquisition sweeps and Smart Download engine make every download
 * decision from there.
 *
 * This module downloads nothing and scores no releases. If it ever needs to, the
 * answer is to call the acquisition engine, not to grow one here.
 */
@Module({
  providers: [DiscoveryProviderRegistry],
  exports: [DiscoveryProviderRegistry],
})
export class MediaDiscoveryModule {}
