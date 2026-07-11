import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { SettingsModule } from '../settings/settings.module';
import { TorrentsService } from './torrents.service';
import { TorrentsController } from './torrents.controller';
import { TorrentSyncService } from './torrent-sync.service';
import { TorrentParkingService } from './torrent-parking.service';

@Module({
  imports: [FilesModule, SettingsModule], // FilePathService: validate save/move paths vs roots
  providers: [TorrentsService, TorrentSyncService, TorrentParkingService],
  controllers: [TorrentsController],
  exports: [TorrentsService, TorrentParkingService],
})
export class TorrentsModule {}
