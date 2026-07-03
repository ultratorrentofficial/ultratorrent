import { SetMetadata } from '@nestjs/common';

export const REQUIRES_MODULE_KEY = 'requires_module';

/**
 * Declares that a route (or controller) belongs to a registry module. The
 * ModuleGuard rejects the request when that module is not currently enabled
 * (disabled by an admin, or locked because the tier isn't licensed).
 */
export const RequiresModule = (moduleId: string) =>
  SetMetadata(REQUIRES_MODULE_KEY, moduleId);
