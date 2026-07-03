import {
  Controller,
  Delete,
  Get,
  Global,
  Module,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PERMISSIONS } from '@ultratorrent/shared';
import { MediaService, RenameRequest } from './media.service';
import { SettingsModule } from '../settings/settings.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';

@ApiTags('media')
@ApiBearerAuth()
@Controller('media')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Get('presets')
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  presets() {
    return this.media.presets();
  }

  @Get('libraries')
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  libraries() {
    return this.media.listLibraries();
  }

  @Post('libraries')
  @RequirePermissions(PERMISSIONS.FILES_MANAGE)
  createLibrary(@Req() req: Request) {
    return this.media.createLibrary(req.body ?? {});
  }

  @Patch('libraries/:id')
  @RequirePermissions(PERMISSIONS.FILES_MANAGE)
  updateLibrary(@Param('id') id: string, @Req() req: Request) {
    return this.media.updateLibrary(id, req.body ?? {});
  }

  @Delete('libraries/:id')
  @RequirePermissions(PERMISSIONS.FILES_MANAGE)
  removeLibrary(@Param('id') id: string) {
    return this.media.removeLibrary(id);
  }

  @Post('preview')
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  preview(@Req() req: Request) {
    return this.media.buildPlan((req.body ?? {}) as RenameRequest);
  }

  @Post('apply')
  @RequirePermissions(PERMISSIONS.FILES_MANAGE)
  apply(@Req() req: Request) {
    return this.media.apply((req.body ?? {}) as RenameRequest);
  }

  @Get('history')
  @RequirePermissions(PERMISSIONS.FILES_VIEW)
  history() {
    return this.media.history();
  }
}

@Global()
@Module({
  imports: [SettingsModule],
  providers: [MediaService],
  controllers: [MediaController],
  exports: [MediaService],
})
export class MediaModule {}
