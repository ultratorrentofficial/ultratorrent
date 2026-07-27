import { Controller, Get, UseGuards } from '@nestjs/common';
import type { ActionCatalog } from '@ultratorrent/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser, type AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ContextActionService } from './context-action.service';

/**
 * The Context-Aware Management Actions catalogue.
 *
 * Authenticated but **not** permission-gated, deliberately and for the same
 * reason `GET /api/modules/enabled` is not: the answer is derived entirely from
 * the caller's own grants, so it discloses nothing they could not already infer
 * by watching which buttons appear. Requiring a permission to ask "what may I
 * do?" would mean a user without it sees an empty interface.
 */
@Controller('context-actions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class ContextActionsController {
  constructor(private readonly actions: ContextActionService) {}

  /**
   * Everything this caller could do, before a selection narrows it.
   *
   * Fetched once per session and re-filtered in the browser as the selection
   * changes — see the resolution split in `@ultratorrent/shared/actions`.
   */
  @Get('catalog')
  catalog(@CurrentUser() user: AuthenticatedUser): ActionCatalog {
    return this.actions.catalogFor(user);
  }
}
