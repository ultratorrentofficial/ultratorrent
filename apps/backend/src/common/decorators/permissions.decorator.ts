import { SetMetadata } from '@nestjs/common';
import { Permission } from '@ultratorrent/shared';

export const PERMISSIONS_KEY = 'required_permissions';

/**
 * Declares the permissions required to invoke a route. The PermissionsGuard
 * enforces that the authenticated principal holds ALL listed permissions
 * (SUPER_ADMIN bypasses the check).
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
