import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { FilePathService } from './file-path.service';
import { FilesService } from './files.service';
import { TrashService } from './trash.service';
import { FileCleanupService } from './file-cleanup.service';
import { MoveConflictService } from './move-conflict.service';
import { FilesController } from './files.controller';

/**
 * Path-safe file management for downloaded content: browse/preview/download,
 * create-folder/rename/move/copy, Trash-backed delete, bulk operations, and the
 * Cleanup Wizard. PrismaService, AuditService, and RealtimeGateway are provided
 * by their global modules. All mutating routes are RBAC-guarded and audited.
 */
@Module({
  imports: [SettingsModule],
  providers: [FilePathService, FilesService, TrashService, FileCleanupService, MoveConflictService],
  controllers: [FilesController],
  exports: [FilesService, TrashService, FileCleanupService, FilePathService],
})
export class FilesModule {}
