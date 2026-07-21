import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { JobsService, JobStatus, JobSubsystem } from './jobs.service';

/**
 * `GET /api/jobs` — the cross-subsystem job list behind every workspace Jobs
 * surface and the System global jobs view. Authenticated; the service filters to
 * the subsystems the caller may view (no single `@RequirePermissions` because the
 * visible set is per-user, computed from their permissions). Read-only.
 */
@ApiTags('jobs')
@ApiBearerAuth()
@Controller('jobs')
@UseGuards(JwtAuthGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('subsystem') subsystem?: JobSubsystem,
    @Query('status') status?: JobStatus,
    @Query('active') active?: string,
    @Query('limit') limit?: string,
  ) {
    return this.jobs.list(user, {
      subsystem,
      status,
      active: active === 'true' || active === '1',
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
