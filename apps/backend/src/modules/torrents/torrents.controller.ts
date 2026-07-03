import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  FilePriority,
  PERMISSIONS,
  TorrentPriority,
  TorrentState,
} from '@ultratorrent/shared';
import { TorrentsService } from './torrents.service';
import {
  AddTorrentDto,
  BulkActionDto,
  MoveStorageDto,
  SetFilePriorityDto,
  SetLimitDto,
  TrackerDto,
} from './dto/torrent.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

function reqCtx(req: Request) {
  return {
    ipAddress: (req.headers['x-forwarded-for'] as string) ?? req.ip,
    userAgent: req.headers['user-agent'],
  };
}

@ApiTags('torrents')
@ApiBearerAuth()
@Controller('torrents')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TorrentsController {
  constructor(private readonly torrents: TorrentsService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  list(
    @Query('engineId') engineId?: string,
    @Query('state') state?: TorrentState,
    @Query('category') category?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: any,
    @Query('sortDir') sortDir?: 'asc' | 'desc',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.torrents.list({
      engineId,
      state,
      category,
      search,
      sortBy,
      sortDir,
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
    });
  }

  @Get(':hash')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  get(@Param('hash') hash: string, @Query('engineId') engineId?: string) {
    return this.torrents.get(hash, engineId);
  }

  @Get(':hash/matched-rule')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  matchedRule(@Param('hash') hash: string) {
    return this.torrents.getMatchedRule(hash);
  }

  @Get(':hash/files')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  files(@Param('hash') hash: string, @Query('engineId') engineId?: string) {
    return this.torrents.getFiles(hash, engineId);
  }

  @Get(':hash/peers')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  peers(@Param('hash') hash: string, @Query('engineId') engineId?: string) {
    return this.torrents.getPeers(hash, engineId);
  }

  @Get(':hash/trackers')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  trackers(@Param('hash') hash: string, @Query('engineId') engineId?: string) {
    return this.torrents.getTrackers(hash, engineId);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.TORRENTS_ADD)
  add(
    @Body() dto: AddTorrentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.torrents.add(dto, dto.engineId, user, reqCtx(req));
  }

  @Post('upload')
  @RequirePermissions(PERMISSIONS.TORRENTS_ADD)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: AddTorrentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.torrents.add(
      { ...dto, file: file.buffer },
      dto.engineId,
      user,
      reqCtx(req),
    );
  }

  @Post('bulk')
  @RequirePermissions(PERMISSIONS.TORRENTS_VIEW)
  bulk(
    @Body() dto: BulkActionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.torrents.bulk(dto.hashes, dto.action, dto.engineId, user, reqCtx(req));
  }

  @Post(':hash/start')
  @RequirePermissions(PERMISSIONS.TORRENTS_START)
  start(@Param('hash') hash: string, @Query('engineId') engineId: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.start(hash, engineId, user, reqCtx(req));
  }

  @Post(':hash/stop')
  @RequirePermissions(PERMISSIONS.TORRENTS_STOP)
  stop(@Param('hash') hash: string, @Query('engineId') engineId: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.stop(hash, engineId, user, reqCtx(req));
  }

  @Post(':hash/pause')
  @RequirePermissions(PERMISSIONS.TORRENTS_PAUSE)
  pause(@Param('hash') hash: string, @Query('engineId') engineId: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.pause(hash, engineId, user, reqCtx(req));
  }

  @Post(':hash/resume')
  @RequirePermissions(PERMISSIONS.TORRENTS_RESUME)
  resume(@Param('hash') hash: string, @Query('engineId') engineId: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.resume(hash, engineId, user, reqCtx(req));
  }

  @Post(':hash/recheck')
  @RequirePermissions(PERMISSIONS.TORRENTS_RECHECK)
  recheck(@Param('hash') hash: string, @Query('engineId') engineId: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.recheck(hash, engineId, user, reqCtx(req));
  }

  @Delete(':hash')
  @RequirePermissions(PERMISSIONS.TORRENTS_DELETE)
  remove(@Param('hash') hash: string, @Query('engineId') engineId: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.remove(hash, engineId, user, reqCtx(req));
  }

  @Delete(':hash/data')
  @RequirePermissions(PERMISSIONS.TORRENTS_DELETE_DATA)
  removeData(@Param('hash') hash: string, @Query('engineId') engineId: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.removeData(hash, engineId, user, reqCtx(req));
  }

  @Post(':hash/move')
  @RequirePermissions(PERMISSIONS.TORRENTS_MOVE)
  move(@Param('hash') hash: string, @Body() dto: MoveStorageDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.move(hash, dto.destination, dto.engineId, user, reqCtx(req));
  }

  @Post(':hash/limits/upload')
  @RequirePermissions(PERMISSIONS.TORRENTS_MANAGE_LIMITS)
  upLimit(@Param('hash') hash: string, @Body() dto: SetLimitDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.setUploadLimit(hash, dto.bytesPerSec, dto.engineId, user, reqCtx(req));
  }

  @Post(':hash/limits/download')
  @RequirePermissions(PERMISSIONS.TORRENTS_MANAGE_LIMITS)
  downLimit(@Param('hash') hash: string, @Body() dto: SetLimitDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.setDownloadLimit(hash, dto.bytesPerSec, dto.engineId, user, reqCtx(req));
  }

  @Post(':hash/files/priority')
  @RequirePermissions(PERMISSIONS.TORRENTS_MANAGE_FILES)
  filePriority(@Param('hash') hash: string, @Body() dto: SetFilePriorityDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.setFilePriority(hash, dto.fileIndex, dto.priority as FilePriority, dto.engineId, user, reqCtx(req));
  }

  @Post(':hash/trackers')
  @RequirePermissions(PERMISSIONS.TORRENTS_MANAGE_TRACKERS)
  addTracker(@Param('hash') hash: string, @Body() dto: TrackerDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.addTracker(hash, dto.url, dto.engineId, user, reqCtx(req));
  }

  @Delete(':hash/trackers')
  @RequirePermissions(PERMISSIONS.TORRENTS_MANAGE_TRACKERS)
  removeTracker(@Param('hash') hash: string, @Body() dto: TrackerDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.torrents.removeTracker(hash, dto.url, dto.engineId, user, reqCtx(req));
  }
}
