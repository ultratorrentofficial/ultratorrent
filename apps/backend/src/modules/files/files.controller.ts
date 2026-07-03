import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { FilesService } from './files.service';
import { FileCleanupService } from './file-cleanup.service';
import { TrashService } from './trash.service';
import { AuditService } from '../audit/audit.service';
import {
  DEFAULT_ROOT_PATH_KEY,
  FilePathService,
  type FileOpContext,
} from './file-path.service';
import {
  BulkOperationDto,
  CleanupExecuteDto,
  CleanupPreviewDto,
  CopyFileDto,
  CreateFolderDto,
  DeleteFileDto,
  MoveFileDto,
  PathDto,
  RenameFileDto,
  SetRootPathDto,
  TrashRestoreDto,
} from './dto/file.dto';

/** Extract audit context (user + ip + UA) from the request. */
function opCtx(req: Request, user?: AuthenticatedUser): FileOpContext {
  return {
    userId: user?.id,
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.ip,
    userAgent: req.headers['user-agent'],
  };
}

@ApiTags('files')
@ApiBearerAuth()
@Controller('files')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly cleanup: FileCleanupService,
    private readonly trash: TrashService,
    private readonly paths: FilePathService,
    private readonly audit: AuditService,
  ) {}

  // --- read ---
  @Get()
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  browse(@Query('path') p?: string) {
    return this.files.browse(p ?? '/');
  }

  /** Effective Default Root Path + read/write status (for the picker + Settings). */
  @Get('root')
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  root() {
    return this.paths.rootInfo();
  }

  /** Change the Default Root Path — validated, narrowed to FILE_MANAGER_ROOTS, audited. */
  @Put('root')
  @RequirePermissions(PERMISSIONS.SETTINGS_MANAGE_ROOT_PATH)
  async setRoot(
    @Body() dto: SetRootPathDto,
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const ctx = opCtx(req, user);
    try {
      const { previous, rootInfo } = await this.paths.setDefaultRoot(dto.path);
      await this.audit.record({
        userId: ctx.userId,
        action: 'settings.update_root_path',
        objectType: 'setting',
        objectId: DEFAULT_ROOT_PATH_KEY,
        result: 'success',
        metadata: { previous, next: rootInfo.root },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      return rootInfo;
    } catch (err) {
      await this.audit.record({
        userId: ctx.userId,
        action: 'settings.update_root_path',
        objectType: 'setting',
        objectId: DEFAULT_ROOT_PATH_KEY,
        result: 'failure',
        metadata: { requested: dto.path, error: (err as Error).message },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      throw err;
    }
  }

  @Get('properties')
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  properties(@Query('path') p: string) {
    return this.files.properties(p);
  }

  @Get('preview')
  @RequirePermissions(PERMISSIONS.FILES_PREVIEW)
  preview(@Query('path') p: string) {
    return this.files.preview(p);
  }

  @Get('download')
  @RequirePermissions(PERMISSIONS.FILES_DOWNLOAD)
  download(@Query('path') p: string, @Res({ passthrough: true }) res: Response) {
    return this.files.download(p, res);
  }

  // --- mutate ---
  @Post('folders')
  @RequirePermissions(PERMISSIONS.FILES_CREATE_FOLDER)
  createFolder(@Body() dto: CreateFolderDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.files.createFolder(dto, opCtx(req, user));
  }

  @Post('rename')
  @RequirePermissions(PERMISSIONS.FILES_RENAME)
  rename(@Body() dto: RenameFileDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.files.rename(dto, opCtx(req, user));
  }

  @Post('move')
  @RequirePermissions(PERMISSIONS.FILES_MOVE)
  move(@Body() dto: MoveFileDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.files.move(dto, opCtx(req, user));
  }

  @Post('copy')
  @RequirePermissions(PERMISSIONS.FILES_COPY)
  copy(@Body() dto: CopyFileDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.files.copy(dto, opCtx(req, user));
  }

  @Post('delete')
  @RequirePermissions(PERMISSIONS.FILES_DELETE)
  remove(@Body() dto: DeleteFileDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.files.remove(dto, opCtx(req, user));
  }

  @Post('bulk')
  @RequirePermissions(PERMISSIONS.FILES_BULK_ACTIONS)
  bulk(@Body() dto: BulkOperationDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.files.bulk(dto, opCtx(req, user));
  }

  // --- cleanup ---
  @Post('cleanup-preview')
  @RequirePermissions(PERMISSIONS.FILES_CLEANUP)
  cleanupPreview(@Body() dto: CleanupPreviewDto) {
    return this.cleanup.preview(dto);
  }

  @Post('cleanup-execute')
  @RequirePermissions(PERMISSIONS.FILES_CLEANUP)
  cleanupExecute(@Body() dto: CleanupExecuteDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.cleanup.execute(dto, opCtx(req, user));
  }

  // --- trash ---
  @Get('trash')
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  listTrash() {
    return this.trash.list();
  }

  @Post('trash/restore')
  @RequirePermissions(PERMISSIONS.FILES_DELETE)
  restore(@Body() dto: TrashRestoreDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.trash.restore(dto.id, dto.overwrite, opCtx(req, user));
  }

  @Post('trash/purge')
  @RequirePermissions(PERMISSIONS.FILES_DELETE)
  purge(@Body() dto: { id: string }, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.trash.purge(dto.id, opCtx(req, user));
  }

  @Post('trash/empty')
  @RequirePermissions(PERMISSIONS.FILES_DELETE)
  empty(@Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.trash.empty(opCtx(req, user));
  }
}
