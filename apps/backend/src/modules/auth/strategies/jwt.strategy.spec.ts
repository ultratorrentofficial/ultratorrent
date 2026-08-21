import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';

/**
 * The access-token strategy re-validates against the DB rather than trusting claims
 * for the full TTL, so a deleted/deactivated user or revoked permission takes effect
 * within the cache window — with a fail-open on DB error so a blip can't lock everyone out.
 */
function make(userFindUnique: jest.Mock, audit = { record: jest.fn() }) {
  const config = { get: () => 'x'.repeat(40) } as any;
  const prisma = { user: { findUnique: userFindUnique } } as any;
  return Object.assign(new JwtStrategy(config, prisma, audit as any), { __audit: audit });
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

/**
 * The fallback is deliberate — during a database outage the torrent list and
 * engine pages still work, and locking the operator out then would hand anyone
 * who can disrupt Postgres an authentication outage as a bonus. What was wrong
 * is that it happened in complete silence, so nobody could tell it had.
 */
describe('degraded revalidation is reported', () => {
  const dbDown = () => jest.fn().mockRejectedValue(new Error('db unreachable'));

  it('warns ONCE per outage, not once per request', async () => {
    // This path runs on every authenticated call; a busy instance would bury
    // the very warning it is meant to raise.
    const svc = make(dbDown());
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    for (let i = 0; i < 5; i += 1) await svc.validate(payload() as any);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/DEGRADED/);
  });

  it('still admits the request on its token claims', async () => {
    const svc = make(dbDown());
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    const res = await svc.validate(payload() as any);
    expect(res).toMatchObject({ id: 'u1', permissions: ['a'] });
  });

  it('reports recovery, with how many requests were admitted', async () => {
    const find = jest.fn().mockRejectedValue(new Error('db unreachable'));
    const svc = make(find);
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    await svc.validate(payload() as any);
    await svc.validate(payload({ sub: 'u2' }) as any);

    find.mockResolvedValue(activeUser);
    await svc.validate(payload({ sub: 'u3' }) as any);

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toMatch(/recovered — 2 request/);
  });

  it('audits the outage on recovery, when the database can finally take the row', async () => {
    const find = jest.fn().mockRejectedValue(new Error('db unreachable'));
    const audit = { record: jest.fn() };
    const svc = make(find, audit);
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    await svc.validate(payload() as any);

    find.mockResolvedValue(activeUser);
    await svc.validate(payload({ sub: 'u9' }) as any);

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'auth.revalidation_degraded',
        metadata: { admittedRequests: 1 },
      }),
    );
  });

  it('fails closed when AUTH_FAIL_CLOSED is set', async () => {
    // The other threat model, available as a setting rather than a patch.
    process.env.AUTH_FAIL_CLOSED = 'true';
    try {
      const svc = make(dbDown());
      await expect(svc.validate(payload() as any)).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      delete process.env.AUTH_FAIL_CLOSED;
    }
  });
});
