import { Injectable } from '@nestjs/common';
import {
  EngineConnectionConfig,
  TorrentEngineProvider,
} from '../../domain/engine/torrent-engine-provider.interface';
import { RTorrentProvider } from './rtorrent/rtorrent.provider';

/**
 * Instantiates a concrete {@link TorrentEngineProvider} from stored connection
 * config. Adding a new engine = adding a `case` here plus its provider class.
 */
@Injectable()
export class EngineProviderFactory {
  create(config: EngineConnectionConfig): TorrentEngineProvider {
    switch (config.kind) {
      case 'rtorrent':
        return new RTorrentProvider(config);
      case 'qbittorrent':
      case 'transmission':
      case 'deluge':
        throw new Error(
          `Engine "${config.kind}" is planned but not yet implemented`,
        );
      default:
        throw new Error(`Unknown engine kind: ${config.kind}`);
    }
  }
}
