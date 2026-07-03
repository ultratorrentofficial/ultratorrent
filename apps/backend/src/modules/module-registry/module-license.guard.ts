import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRES_MODULE_KEY } from './module-access.decorator';
import { ModuleRegistryService } from './module-registry.service';
import { AuthenticatedUser } from '../../common/decorators/current-user.decorator';

/**
 * Blocks requests to a route whose owning module is not enabled. This is the
 * authoritative backend enforcement — frontend gating is only UX.
 */
@Injectable()
export class ModuleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly registry: ModuleRegistryService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const moduleId = this.reflector.getAllAndOverride<string>(
      REQUIRES_MODULE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!moduleId) return true;

    const status = this.registry.getStatus(moduleId);
    if (status?.enabled) return true;

    const req = context.switchToHttp().getRequest();
    const user = req.user as AuthenticatedUser | undefined;
    // Best-effort audit of the access violation (never blocks the response).
    void this.registry.recordAccessViolation(moduleId, user?.id, req.url);

    const reason = status?.reason ?? 'module is not available';
    throw new ForbiddenException(
      `The "${moduleId}" module is disabled: ${reason}`,
    );
  }
}
