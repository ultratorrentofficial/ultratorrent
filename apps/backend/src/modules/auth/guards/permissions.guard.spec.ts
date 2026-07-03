import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS, SystemRole } from '@ultratorrent/shared';
import { PermissionsGuard } from './permissions.guard';

function contextWith(user: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => null,
    getClass: () => null,
  } as any;
}

describe('PermissionsGuard', () => {
  let reflector: Reflector;
  let guard: PermissionsGuard;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new PermissionsGuard(reflector);
  });

  it('allows routes without required permissions', () => {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    expect(guard.canActivate(contextWith({}))).toBe(true);
  });

  it('allows when the user holds all required permissions', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([PERMISSIONS.TORRENTS_ADD]);
    const user = { roles: [], permissions: [PERMISSIONS.TORRENTS_ADD] };
    expect(guard.canActivate(contextWith(user))).toBe(true);
  });

  it('denies when a required permission is missing', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([PERMISSIONS.TORRENTS_DELETE_DATA]);
    const user = { roles: [], permissions: [PERMISSIONS.TORRENTS_VIEW] };
    expect(() => guard.canActivate(contextWith(user))).toThrow(
      ForbiddenException,
    );
  });

  it('lets SUPER_ADMIN bypass granular checks', () => {
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockReturnValue([PERMISSIONS.USERS_MANAGE]);
    const user = { roles: [SystemRole.SUPER_ADMIN], permissions: [] };
    expect(guard.canActivate(contextWith(user))).toBe(true);
  });
});
