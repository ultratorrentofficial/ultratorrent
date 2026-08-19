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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  PERMISSIONS,
  PREVIEW_TEXT_ENCODINGS,
  SystemRole,
  type MediaTicket,
  type PreviewTextEncoding,
} from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { Public } from '../../common/decorators/public.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { FilesService } from './files.service';
import { FileCleanupService } from './file-cleanup.service';
import { MoveConflictService } from './move-conflict.service';
import { TrashService } from './trash.service';
import { signMediaTicket, verifyMediaTicket } from './media-ticket';
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

/** Narrow a caller-supplied encoding to one the decoder knows, or nothing. */
export function parsePreviewEncoding(value: unknown): PreviewTextEncoding | null {
  return typeof value === 'string' && (PREVIEW_TEXT_ENCODINGS as readonly string[]).includes(value)
    ? (value as PreviewTextEncoding)
    : null;
}

/**
 * Compare two root-relative paths as the safety layer would see them, so a
 * ticket for `movies/a.mkv` still authorises `/movies/a.mkv`. Only leading
 * slashes differ here; anything else is left alone and therefore mismatches.
 */
export function normalizeRelative(p: unknown): string {
  return typeof p === 'string' ? `/${p.replace(/^\/+/, '')}` : '';
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
    private readonly config: ConfigService,
  ) {}

  /**
   * Key the media tickets are signed with.
   *
   * Reuses the JWT access secret rather than adding an env var nobody would set:
   * a ticket is the same trust as the token that minted it, and a deployment
   * that rotates its JWT secret correctly invalidates outstanding tickets too.
   */
  private mediaSecret(): string {
    return this.config.get<string>('jwt.accessSecret')!;
  }

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

  /**
   * What to show for one file, plus its text when it has any.
   *
   * `encoding` lets the viewer override the server's detection — an NFO the
   * heuristic read as Latin-1 is re-requested as CP437 from the same route
   * rather than re-decoded in the browser, which would need the raw bytes.
   */
  @Get('preview')
  @RequirePermissions(PERMISSIONS.FILES_PREVIEW)
  preview(@Query('path') p: string, @Query('encoding') encoding?: string) {
    return this.files.preview(p, { encoding: parsePreviewEncoding(encoding) });
  }

  /**
   * Mint a short-lived grant for the stream route below.
   *
   * Requires the same permission as previewing, because that is what it enables:
   * `<img>`/`<video>` cannot send a bearer token, so the grant moves into the
   * URL. Scoped to the one path asked for, and the path is resolved here — a
   * ticket is never issued for something the caller could not have opened.
   */
  @Post('media-ticket')
  @RequirePermissions(PERMISSIONS.FILES_PREVIEW)
  async mediaTicket(
    @Body('path') p: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MediaTicket> {
    const resolved = await this.paths.safety.resolveExisting(p);
    const relative = this.paths.safety.toRelative(resolved);
    const { token, expiresAt } = signMediaTicket(this.mediaSecret(), { p: relative, u: user?.id });
    /*
     * The ticket travels without a URL around it. The client already knows where
     * the API lives, and having the server guess its own public address from
     * `Host`/`X-Forwarded-*` is how a stream URL ends up pointing at a container
     * name — a whole class of proxy misconfiguration this simply does not have.
     */
    return { token, path: relative, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * Serve a file's bytes inline, with Range support.
   *
   * `@Public` only in the sense that it does not read the `Authorization`
   * header — it is not unauthenticated. The ticket IS the authorisation, and it
   * must both verify and name this exact path: presenting a valid ticket for
   * `/a.jpg` while asking for `/b.mkv` is a forgery attempt, not a mismatch.
   *
   * Players routinely probe with HEAD for the length and `Accept-Ranges` before
   * opening a stream. There is no `@Head` decorator for that: Nest stores one
   * method per handler, so stacking `@Head` on `@Get` would register only one of
   * them — Express already routes a HEAD to the GET handler when no HEAD route
   * exists, which is why the handler checks `req.method` instead.
   */
  @Public()
  /*
   * Exempt from the global rate limit (120 requests/minute). A `<video>` issues
   * one Range request per buffer window and a burst of them on every seek, so a
   * per-request budget sized for API calls would 429 mid-playback and read as a
   * broken player. What stops abuse here is the ticket: it cannot be obtained
   * without an authenticated, permission-checked call, and it names one path.
   */
  @SkipThrottle()
  @Get('stream')
  stream(
    @Query('path') p: string,
    @Query('ticket') ticket: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const payload = verifyMediaTicket(this.mediaSecret(), ticket);
    if (!payload) throw new UnauthorizedException('Invalid or expired media ticket');
    if (normalizeRelative(payload.p) !== normalizeRelative(p)) {
      throw new ForbiddenException('Ticket does not authorise this path');
    }
    /*
     * Helmet sets `X-Frame-Options: SAMEORIGIN` on every response, which would
     * block the inline PDF frame whenever the app and the API are on different
     * origins — the ordinary case in development, and in any deployment that
     * does not proxy them together. Replaced with its modern equivalent, scoped
     * to the origins CORS already trusts, so the resource stays unframeable by
     * anyone else.
     */
    res.removeHeader('X-Frame-Options');
    const origins = (this.config.get<string>('corsOrigin') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
    res.set({ 'Content-Security-Policy': `frame-ancestors 'self' ${origins.join(' ')}`.trim() });

    // A HEAD is a probe for length and range support. It gets every header the
    // GET would carry and no body — opening a read stream Express would then
    // discard leaks the descriptor.
    return this.files.streamMedia(p, req.headers.range, res, { headOnly: req.method === 'HEAD' });
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

  /**
   * What deleting this path would also affect: the torrents whose payload it
   * belongs to, and the bytes a delete would ACTUALLY free (zero while a
   * hardlink survives). Read-only.
   */
  @Post('delete/preview')
  @RequirePermissions(PERMISSIONS.FILES_DELETE)
  previewDelete(@Body() dto: DeleteFileDto) {
    return this.files.deletionPreview(dto.path);
  }

  /** The same preflight, aggregated over a multi-selection. */
  @Post('bulk/delete-preview')
  @RequirePermissions(PERMISSIONS.FILES_DELETE)
  previewBulkDelete(@Body() dto: { paths?: string[] }) {
    return this.files.bulkDeletionPreview(dto?.paths ?? []);
  }

  @Post('delete')
  @RequirePermissions(PERMISSIONS.FILES_DELETE)
  remove(@Body() dto: DeleteFileDto, @Req() req: Request, @CurrentUser() user: AuthenticatedUser) {
    /*
     * Acting on the torrent is a SECOND authority. `files.delete` says someone
     * may remove a file; it must not also let them stop another user's seed or
     * destroy the payload behind it.
     */
    const held = new Set(user?.permissions ?? []);
    if (dto.torrentAction === 'stop' && !held.has(PERMISSIONS.TORRENTS_DELETE)) {
      throw new ForbiddenException('Stopping the source torrent requires torrents.delete');
    }
    if (dto.torrentAction === 'stop_and_delete' && !held.has(PERMISSIONS.TORRENTS_DELETE_DATA)) {
      throw new ForbiddenException('Deleting the source payload requires torrents.delete_data');
    }
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
    // Same second authority as the single delete: `files.delete` must not carry
    // the power to stop or destroy a torrent.
    const held = new Set(user?.permissions ?? []);
    if (dto.torrentAction === 'stop' && !held.has(PERMISSIONS.TORRENTS_DELETE)) {
      throw new ForbiddenException('Stopping the source torrent requires torrents.delete');
    }
    if (dto.torrentAction === 'stop_and_delete' && !held.has(PERMISSIONS.TORRENTS_DELETE_DATA)) {
      throw new ForbiddenException('Deleting the source payload requires torrents.delete_data');
    }
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
