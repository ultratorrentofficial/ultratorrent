import { Module, type OnModuleInit } from '@nestjs/common';
import { CapabilityRegistry } from '../context-actions/capability-registry.service';
import { TORRENT_ACTIONS } from './torrents-actions';
import { FilesModule } from '../files/files.module';
import { SettingsModule } from '../settings/settings.module';
import { TorrentsService } from './torrents.service';
import { TorrentsController } from './torrents.controller';
import { TorrentSyncService } from './torrent-sync.service';
import { TorrentParkingService } from './torrent-parking.service';
import { TorrentNameRepairService } from './torrent-name-repair.service';

@Module({
  // FilePathService: validate save/move paths vs roots.
  // MediaModule is deliberately NOT imported: it closes the
  // automation → rss → media-intake → media cycle and kills the app at
  // bootstrap. TorrentsService resolves MediaBulkService lazily via ModuleRef.
  imports: [FilesModule, SettingsModule],
  providers: [
    TorrentsService,
    TorrentSyncService,
    TorrentParkingService,
    TorrentNameRepairService,
  ],
  controllers: [TorrentsController],
  exports: [TorrentsService, TorrentParkingService],
})
/** Contributes the torrent actions to the CAMA registry at boot. */
export class TorrentsModule implements OnModuleInit {
  constructor(private readonly capabilities: CapabilityRegistry) {}

  onModuleInit(): void {
    this.capabilities.registerAll(TORRENT_ACTIONS);
  }
}
