import { Body, Controller, Get, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS as P } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { GeoIpSettingsService, type GeoIpSettingsPatch } from './geoip-settings.service';
import { GeoIpDownloaderService } from './geoip-downloader.service';

/**
 * Configure IP geolocation and drive its database downloader — the same shape as
 * the IMDb dataset admin: a config area (with a redacted secret), a status read,
 * and a manual "update now". Reading status is gated on VIEW_REPORTS (the same
 * surface that shows the location charts); changing config or triggering a
 * download requires the analytics settings-manage permission.
 */
@ApiTags('geoip')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('geoip')
export class GeoIpController {
  constructor(
    private readonly settings: GeoIpSettingsService,
    private readonly downloader: GeoIpDownloaderService,
  ) {}

  @Get('config')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS)
  config() {
    return this.settings.readRedacted();
  }

  @Patch('config')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS)
  updateConfig(@Body() body: GeoIpSettingsPatch) {
    return this.settings.update(body ?? {});
  }

  @Get('status')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW_REPORTS)
  status() {
    return this.downloader.status();
  }

  @Post('update')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_SETTINGS)
  update(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.downloader.updateNow({
      userId: user.id,
      ipAddress: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
    });
  }
}
