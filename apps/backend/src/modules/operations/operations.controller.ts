import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  OPERATIONS_CONTRACT_VERSION,
  OPERATIONS_DOMAINS,
  OPERATIONS_EVENT_CHANNEL,
  PERMISSIONS,
  type OperationsCapabilities,
  type OperationsDomainKey,
  type OperationsSnapshot,
} from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { SystemService } from '../system/system.module';
import {
  MAX_ITEM_CAP,
  OperationsSnapshotService,
  DEFAULT_ITEM_CAP,
} from './operations-snapshot.service';

/**
 * The shortest interval the server wants a console to poll at.
 *
 * Advisory, not enforced — a limit the server *rejected* would make a burst of
 * consoles into an outage of the thing they are watching, which is the opposite
 * of the intent. It is published so a client does not have to guess, and the
 * real protection is that every domain is capped and every read is of state some
 * service already holds.
 */
const MIN_SNAPSHOT_INTERVAL_SECONDS = 2;

/**
 * The console's two read endpoints.
 *
 * There is no third, and there is no mutation. `operations` is an observability
 * surface: everything it returns is a projection of state another module owns,
 * and every way to CHANGE that state stays on the module that owns it, behind
 * that module's own permissions. A console that could act would be a second
 * management client with a second authorization story.
 */
@ApiTags('operations')
@ApiBearerAuth()
@Controller('operations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions(PERMISSIONS.CONSOLE_VIEW)
export class OperationsController {
  constructor(
    private readonly snapshots: OperationsSnapshotService,
    private readonly system: SystemService,
  ) {}

  /**
   * What a console learns before it renders anything.
   *
   * Answers three questions in one round trip — which contract this backend
   * speaks, which domains it can serve, and which of those THIS caller may read
   * — so the console can hide what it cannot fetch instead of rendering a wall
   * of permission errors. It is a convenience for the client and never the
   * authorization: {@link snapshot} re-checks every domain itself.
   */
  @Get('capabilities')
  @ApiOperation({ summary: 'Operations contract, server build, and this caller’s domains' })
  capabilities(@CurrentUser() user: AuthenticatedUser): OperationsCapabilities {
    const build = this.system.version();
    return {
      contractVersion: OPERATIONS_CONTRACT_VERSION,
      server: {
        product: build.product,
        version: build.version,
        apiVersion: build.apiVersion,
        gitSha: build.gitSha,
        gitTag: build.gitTag,
        buildTime: build.buildTime,
      },
      /*
       * Every domain, not a subset: this backend has no module-disable switch,
       * so "can serve" is the full list and a client comparing the two lists
       * sees exactly what its own permissions cost it. When a domain can one day
       * be turned off, this is where it drops out.
       */
      availableDomains: [...OPERATIONS_DOMAINS],
      permittedDomains: this.snapshots.permittedDomains(user),
      user: {
        id: user.id,
        username: user.username,
        roles: user.roles ?? [],
        // The caller's own grants, which they can already read from `/auth/me`.
        permissions: user.permissions ?? [],
      },
      eventChannel: OPERATIONS_EVENT_CHANNEL,
      limits: {
        maxItemsPerDomain: MAX_ITEM_CAP,
        minSnapshotIntervalSeconds: MIN_SNAPSHOT_INTERVAL_SECONDS,
      },
    };
  }

  /**
   * One reading of what UltraTorrent is doing right now.
   *
   * `domains` narrows the response — a console showing one panel should not make
   * the backend build thirteen. An unknown domain name is rejected rather than
   * ignored, because a client silently receiving nothing for a typo is the
   * hardest kind of bug to see from the other end.
   */
  @Get('snapshot')
  @ApiOperation({ summary: 'A permission-filtered aggregate of current operational state' })
  @ApiQuery({ name: 'domains', required: false, description: 'Comma-separated domain keys' })
  @ApiQuery({ name: 'limit', required: false, description: `Items per list (max ${MAX_ITEM_CAP})` })
  snapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Query('domains') domains?: string,
    @Query('limit') limit?: string,
  ): Promise<OperationsSnapshot> {
    return this.snapshots.snapshot(user, {
      domains: parseDomains(domains),
      limit: parseLimit(limit),
    });
  }
}

function parseDomains(raw?: string): OperationsDomainKey[] | undefined {
  if (!raw) return undefined;
  const requested = raw
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  if (!requested.length) return undefined;

  const known = new Set<string>(OPERATIONS_DOMAINS);
  const unknown = requested.filter((d) => !known.has(d));
  if (unknown.length) {
    throw new BadRequestException(`Unknown operations domain(s): ${unknown.join(', ')}`);
  }
  return requested as OperationsDomainKey[];
}

/**
 * A limit is clamped by the service, so this only rejects what is not a number
 * at all — `limit=all` must not silently become the default and look honoured.
 */
function parseLimit(raw?: string): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new BadRequestException(`"limit" must be a number (1–${MAX_ITEM_CAP})`);
  }
  return value || DEFAULT_ITEM_CAP;
}
