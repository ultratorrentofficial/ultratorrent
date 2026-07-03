import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Permission, SystemRole } from '@ultratorrent/shared';
import { PERMISSIONS_KEY } from '../../../common/decorators/permissions.decorator';
import { AuthenticatedUser } from '../../../common/decorators/current-user.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const user = context.switchToHttp().getRequest()
      .user as AuthenticatedUser;
    if (!user) throw new ForbiddenException('Not authenticated');

    // Super admins bypass granular checks.
    if (user.roles?.includes(SystemRole.SUPER_ADMIN)) return true;

    const held = new Set(user.permissions ?? []);
    const missing = required.filter((p) => !held.has(p));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing permission(s): ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
