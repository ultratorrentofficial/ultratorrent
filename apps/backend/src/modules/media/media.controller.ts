import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PERMISSIONS } from '@ultratorrent/shared';
import { MediaService, RenameRequest } from './media.service';
import { MediaLibraryService, LibraryInput } from './media-library.service';
import { MediaScannerService } from './media-scanner.service';
import {
  MediaIdentificationService,
  ManualMatchDto,
} from './media-identification.service';
import { MediaItemService, ItemUpdateDto } from './media-item.service';
import { MediaHealthService } from './media-health.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

const P = PERMISSIONS;

@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly libraries: MediaLibraryService,
    private readonly scanner: MediaScannerService,
    private readonly identification: MediaIdentificationService,
    private readonly items: MediaItemService,
    private readonly healthSvc: MediaHealthService,
  ) {}

  // --- overview ----------------------------------------------------------
  @Get('dashboard')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  dashboard() {
    return this.healthSvc.dashboard();
  }

  @Get('health')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  health() {
    return this.healthSvc.health();
  }

  // --- libraries ---------------------------------------------------------
  @Get('libraries')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listLibraries() {
    return this.libraries.list();
  }

  @Post('libraries')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_LIBRARIES)
  createLibrary(@Body() body: LibraryInput) {
    return this.libraries.create(body ?? {});
  }

  @Patch('libraries/:id')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_LIBRARIES)
  updateLibrary(@Param('id') id: string, @Body() body: LibraryInput) {
    return this.libraries.update(id, body ?? {});
  }

  @Delete('libraries/:id')
  @RequirePermissions(P.MEDIA_MANAGER_MANAGE_LIBRARIES)
  removeLibrary(@Param('id') id: string) {
    return this.libraries.remove(id);
  }

  @Post('libraries/:id/scan')
  @RequirePermissions(P.MEDIA_MANAGER_SCAN)
  scanLibrary(@Param('id') id: string) {
    return this.scanner.scanLibrary(id);
  }

  // --- items -------------------------------------------------------------
  @Get('items')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  listItems(
    @Query('mediaType') mediaType?: string,
    @Query('matchStatus') matchStatus?: string,
    @Query('libraryId') libraryId?: string,
  ) {
    return this.items.list({ mediaType, matchStatus, libraryId });
  }

  @Get('items/:id')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  getItem(@Param('id') id: string) {
    return this.items.get(id);
  }

  @Patch('items/:id')
  @RequirePermissions(P.MEDIA_MANAGER_EDIT_METADATA)
  updateItem(@Param('id') id: string, @Body() body: ItemUpdateDto) {
    return this.items.update(id, body ?? {});
  }

  @Post('items/:id/match')
  @RequirePermissions(P.MEDIA_MANAGER_MATCH)
  matchItem(@Param('id') id: string, @Body() body: ManualMatchDto) {
    // A body identifies manually; an empty body re-runs automatic identification.
    if (body && Object.keys(body).length > 0) {
      return this.identification.matchManually(id, body);
    }
    return this.identification.identify(id);
  }

  @Post('items/:id/unmatch')
  @RequirePermissions(P.MEDIA_MANAGER_MATCH)
  unmatchItem(@Param('id') id: string) {
    return this.identification.unmatch(id);
  }

  // --- rename engine (retained) -----------------------------------------
  @Get('presets')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  presets() {
    return this.media.presets();
  }

  @Post('preview')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  preview(@Req() req: Request) {
    return this.media.buildPlan((req.body ?? {}) as RenameRequest);
  }

  @Post('apply')
  @RequirePermissions(P.MEDIA_MANAGER_RENAME)
  apply(@Req() req: Request) {
    return this.media.apply((req.body ?? {}) as RenameRequest);
  }

  @Get('history')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  history() {
    return this.media.history();
  }
}
