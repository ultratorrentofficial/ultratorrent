import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { TorrentsService } from './torrents.service';
import { TorrentsController } from './torrents.controller';
import { TorrentSyncService } from './torrent-sync.service';

@Module({
  imports: [FilesModule], // FilePathService: validate save/move paths vs roots
  providers: [TorrentsService, TorrentSyncService],
  controllers: [TorrentsController],
  exports: [TorrentsService],
})
export class TorrentsModule {}
