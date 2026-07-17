import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

/**
 * The access-token strategy re-validates against the DB rather than trusting claims
 * for the full TTL, so a deleted/deactivated user or revoked permission takes effect
 * within the cache window — with a fail-open on DB error so a blip can't lock everyone out.
 */
function make(userFindUnique: jest.Mock) {
  const config = { get: () => 'x'.repeat(40) } as any;
  const prisma = { user: { findUnique: userFindUnique } } as any;
  return new JwtStrategy(config, prisma);
}
const payload = (over: any = {}) => ({
  sub: 'u1', username: 'alice', roles: ['viewer'], permissions: ['a'], type: 'access', ...over,
});
const activeUser = {
  id: 'u1', username: 'alice', isActive: true,
  roles: [{ role: { name: 'admin', permissions: [{ permission: { key: 'x.manage' } }] } }],
};

describe('JwtStrategy.validate', () => {
  it('rejects a non-access token type', async () => {
    const svc = make(jest.fn());
    await expect(svc.validate(payload({ type: 'refresh' }) as any)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns FRESH roles/permissions from the DB, not the (possibly stale) token claims', async () => {
    const svc = make(jest.fn().mockResolvedValue(activeUser));
    const res = await svc.validate(payload() as any);
    // Token said roles:[viewer] perms:[a]; DB says admin/x.manage — DB wins.
    expect(res).toEqual({ id: 'u1', username: 'alice', roles: ['admin'], permissions: ['x.manage'] });
  });

  it('rejects a deleted user (findUnique → null)', async () => {
    const svc = make(jest.fn().mockResolvedValue(null));
    await expect(svc.validate(payload() as any)).rejects.toThrow(/no longer active/);
  });

  it('rejects a deactivated user (isActive false)', async () => {
    const svc = make(jest.fn().mockResolvedValue({ ...activeUser, isActive: false }));
    await expect(svc.validate(payload() as any)).rejects.toThrow(/no longer active/);
  });

  it('fails OPEN to token claims on a DB error (does not lock everyone out)', async () => {
    const svc = make(jest.fn().mockRejectedValue(new Error('db down')));
    const res = await svc.validate(payload() as any);
    expect(res).toEqual({ id: 'u1', username: 'alice', roles: ['viewer'], permissions: ['a'] });
  });

  it('caches — a second validate within the window does not re-query', async () => {
    const find = jest.fn().mockResolvedValue(activeUser);
    const svc = make(find);
    await svc.validate(payload() as any);
    await svc.validate(payload() as any);
    expect(find).toHaveBeenCalledTimes(1);
  });
});
