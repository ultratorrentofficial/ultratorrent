import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
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
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { FilesService } from './files.service';
import { FileCleanupService } from './file-cleanup.service';
import { MoveConflictService } from './move-conflict.service';
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
  MoveConflictPreflightDto,
  MoveFileDto,
  PathDto,
  RenameFileDto,
  ResolveConflictsDto,
  SetRootPathDto,
  TrashRestoreDto,
} from './dto/file.dto';

/**
 * Which permission each bulk operation really needs.
 *
 * Mirrors `BULK_ACTION_PERMISSIONS` in TorrentsService. `cleanup` deletes files
 * like `delete` does — it is a filtered deletion, not a lesser one — so it
 * carries the same requirement rather than the weaker `files.cleanup`, which
 * governs the separate scan/preview routes.
 */
const BULK_OPERATION_PERMISSIONS: Record<string, string> = {
  move: PERMISSIONS.FILES_MOVE,
  copy: PERMISSIONS.FILES_COPY,
  delete: PERMISSIONS.FILES_DELETE,
  cleanup: PERMISSIONS.FILES_DELETE,
};

/** Refuse a bulk operation the caller could not perform one-at-a-time. */
export function assertBulkOperationAllowed(operation: string, user: AuthenticatedUser): void {
  const required = BULK_OPERATION_PERMISSIONS[operation];
  if (!required) throw new BadRequestException(`Unsupported bulk operation: ${operation}`);
  // SUPER_ADMIN bypasses granular checks, mirroring PermissionsGuard.
  if (user.roles?.includes(SystemRole.SUPER_ADMIN)) return;
  if (!user.permissions?.includes(required)) {
    throw new ForbiddenException(`Missing permission(s): ${required}`);
  }
}

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
    private readonly conflicts: MoveConflictService,
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

  /**
   * Report containment + on-disk state for an arbitrary path. Backs the
   * "validate against the hard root / does this folder exist?" check any
   * path-save form runs before persisting.
   */
  @Get('inspect')
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  inspect(@Query('path') p: string) {
    return this.paths.inspect(p);
  }

  // --- mutate ---
  @Post('folders')
  @RequirePermissions(PERMISSIONS.FILES_CREATE_FOLDER)
  createFolder(@Body() dto: CreateFolderDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.files.createFolder(dto, opCtx(req, user));
  }

  /**
   * Create a directory (recursively) at an absolute path inside the hard roots —
   * used by the "the folder doesn't exist, create it?" confirmation. Idempotent
   * and audited.
   */
  @Post('ensure-dir')
  @RequirePermissions(PERMISSIONS.FILES_CREATE_FOLDER)
  async ensureDir(
    @Body('path') p: string,
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const ctx = opCtx(req, user);
    try {
      const info = await this.paths.ensureDirectory(p);
      await this.audit.record({
        userId: ctx.userId,
        action: 'files.ensure_dir',
        objectType: 'file',
        objectId: info.path,
        result: 'success',
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      return info;
    } catch (err) {
      await this.audit.record({
        userId: ctx.userId,
        action: 'files.ensure_dir',
        objectType: 'file',
        objectId: typeof p === 'string' ? p : '',
        result: 'failure',
        metadata: { error: (err as Error).message },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      throw err;
    }
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

  /**
   * Bulk file operations.
   *
   * The route guard can only require `files.bulk_actions`, because one endpoint
   * serves move, copy, delete and cleanup. Without a second check that made
   * `files.bulk_actions` a superset of every file permission: a user granted it
   * for moving files could **delete** them, since the service dispatches on
   * `dto.operation` with no further authorisation.
   *
   * So the operation's own permission is enforced here, exactly as
   * `TorrentsService.bulk` does for the same reason — that endpoint's guard is
   * likewise blanket (`torrents.view`) with the real check inside.
   */
  @Post('bulk')
  @RequirePermissions(PERMISSIONS.FILES_BULK_ACTIONS)
  bulk(@Body() dto: BulkOperationDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    assertBulkOperationAllowed(dto.operation, user);
    return this.files.bulk(dto, opCtx(req, user));
  }

  // --- move/copy conflict intelligence ---
  /** Read-only: what a planned move/copy would collide with, and how it compares. */
  @Post('move-conflicts')
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  moveConflicts(@Body() dto: MoveConflictPreflightDto) {
    return this.conflicts.analyze(dto.sources, dto.destination);
  }

  /**
   * Carry out the operator's per-conflict decisions. Can move, copy, replace and
   * delete, so it requires the delete permission on top of move/copy — replace and
   * delete_source both dispose of a file.
   */
  @Post('resolve-conflicts')
  @RequirePermissions(PERMISSIONS.FILES_MOVE, PERMISSIONS.FILES_COPY, PERMISSIONS.FILES_DELETE)
  resolveConflicts(@Body() dto: ResolveConflictsDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    return this.files.resolveConflicts(dto, opCtx(req, user));
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
