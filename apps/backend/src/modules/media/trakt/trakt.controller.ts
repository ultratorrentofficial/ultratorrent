/**
 * Trakt endpoints.
 *
 * Every route acts on the CALLING user's own account — the user id comes from the
 * JWT, never from the request body. A Trakt link is personal, and an endpoint that
 * let one user drive another's link would be an account-takeover primitive, not a
 * feature.
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { PERMISSIONS } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';
import type { AuditContext } from '../media-metadata.service';
import { TraktAuthService } from './trakt-auth.service';
import { TraktSyncService } from './trakt-sync.service';

const P = PERMISSIONS;

function ctxOf(req: Request): AuditContext {
  const user = req.user as AuthenticatedUser | undefined;
  return { userId: user?.id, ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

function userIdOf(req: Request): string {
  return (req.user as AuthenticatedUser).id;
}

@ApiTags('media')
@ApiBearerAuth()
@Controller('media/trakt')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TraktController {
  constructor(
    private readonly auth: TraktAuthService,
    private readonly sync: TraktSyncService,
  ) {}

  /** Whether Trakt is configured, and whether THIS user has linked an account. */
  @Get('status')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  status(@Req() req: Request) {
    return this.auth.status(userIdOf(req));
  }

  /** Begin the device flow — returns the code to enter at trakt.tv/activate. */
  @Post('device/start')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  startDevice(@Req() req: Request) {
    return this.auth.startDeviceAuth(userIdOf(req));
  }

  /**
   * One poll of the pending authorization. The client drives the loop at the
   * `intervalSec` Trakt returned — polling faster earns a `slow_down`, and
   * ignoring that gets the application throttled.
   */
  @Post('device/poll')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  pollDevice(@Req() req: Request) {
    return this.auth.pollDeviceAuth(userIdOf(req), ctxOf(req));
  }

  @Delete('link')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  async disconnect(@Req() req: Request) {
    await this.auth.disconnect(userIdOf(req), ctxOf(req));
    return { linked: false };
  }

  /** Which directions to sync, and whose media-server plays belong to this link. */
  @Patch('settings')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  updateSettings(
    @Req() req: Request,
    @Body()
    body: {
      syncCollection?: boolean;
      syncWatched?: boolean;
      syncRatings?: boolean;
      syncWatchlist?: boolean;
      scrobbleEnabled?: boolean;
      mediaServerUserName?: string | null;
    },
  ) {
    return this.auth.updateSettings(userIdOf(req), body ?? {});
  }

  /**
   * Importing a watchlist CREATES acquisition items — i.e. it makes UltraTorrent
   * go and download things — so it needs the watchlist permission, not merely the
   * ability to view the media manager.
   */
  @Post('sync/watchlist')
  @RequirePermissions(P.MEDIA_ACQUISITION_MANAGE_WATCHLIST)
  importWatchlist(@Req() req: Request) {
    return this.sync.importWatchlist(userIdOf(req), ctxOf(req));
  }

  @Post('sync/collection')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  pushCollection(@Req() req: Request) {
    return this.sync.pushCollection(userIdOf(req), ctxOf(req));
  }

  @Post('sync/watched')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  syncWatched(@Req() req: Request) {
    return this.sync.syncWatched(userIdOf(req), ctxOf(req));
  }

  @Post('sync/ratings')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  syncRatings(@Req() req: Request) {
    return this.sync.syncRatings(userIdOf(req), ctxOf(req));
  }

  /** Seed watched state from the media server's existing history. */
  @Post('sync/backfill')
  @RequirePermissions(P.MEDIA_MANAGER_VIEW)
  backfill(@Req() req: Request) {
    return this.sync.backfillWatchesFromMediaServer(userIdOf(req));
  }
}
