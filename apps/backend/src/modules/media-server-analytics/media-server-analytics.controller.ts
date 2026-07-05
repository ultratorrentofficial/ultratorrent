import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { PERMISSIONS } from '@ultratorrent/shared';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { MediaServerIntegrationService } from '../media/media-server-integration.service';
import { MediaServerAnalyticsService } from './media-server-analytics.service';

const P = PERMISSIONS;

/**
 * Media Server Analytics API. Core module, RBAC-gated. Phase 1: dashboard +
 * connection management (delegating to the shared MediaServerIntegrationService)
 * + capability-aware library listing.
 */
@ApiTags('media-server-analytics')
@ApiBearerAuth()
@Controller('media-server-analytics')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MediaServerAnalyticsController {
  constructor(
    private readonly service: MediaServerAnalyticsService,
    private readonly integrations: MediaServerIntegrationService,
  ) {}

  @Get('dashboard')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  dashboard() {
    return this.service.dashboard();
  }

  // --- connections (reuse the shared integration store) -------------------
  @Get('connections')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  listConnections() {
    return this.integrations.list();
  }
  @Post('connections')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  createConnection(@Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.integrations.create(body ?? {}, { userId: u?.id });
  }
  @Get('connections/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  getConnection(@Param('id') id: string) {
    return this.service.connection(id);
  }
  @Patch('connections/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  updateConnection(@Param('id') id: string, @Body() body: Record<string, unknown>, @CurrentUser() u: AuthenticatedUser) {
    return this.integrations.update(id, body ?? {}, { userId: u?.id });
  }
  @Delete('connections/:id')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  deleteConnection(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.integrations.remove(id, { userId: u?.id });
  }
  /** Test + persist server health (status/version/platform/capabilities). */
  @Post('connections/:id/test')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  testConnection(@Param('id') id: string) {
    return this.integrations.healthCheck(id);
  }
  @Post('connections/:id/sync')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_MANAGE_CONNECTIONS)
  syncConnection(@Param('id') id: string, @CurrentUser() u: AuthenticatedUser) {
    return this.integrations.refresh(id, { userId: u?.id });
  }
  @Get('connections/:id/libraries')
  @RequirePermissions(P.MEDIA_SERVER_ANALYTICS_VIEW)
  libraries(@Param('id') id: string) {
    return this.integrations.libraries(id);
  }
}
