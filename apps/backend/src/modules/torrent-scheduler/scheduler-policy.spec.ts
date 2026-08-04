import { BadRequestException } from '@nestjs/common';
import { SchedulerPolicyService } from './scheduler-policy.service';

/**
 * Policy validation.
 *
 * The inherit / unlimited / capped distinction is the whole contract, and it is
 * expressed through `undefined` versus `null` versus a number. If an update
 * collapsed those, a library could no longer lift a global cap and an untouched
 * field would silently become unlimited.
 */
function build(existing: any = { id: 'p1', name: 'x' }) {
  const writes: any[] = [];
  const prisma = {
    torrentSchedulerPolicy: {
      findMany: jest.fn(async () => []),
      findUnique: jest.fn(async () => existing),
      create: jest.fn(async (a: any) => { writes.push(a); return { id: 'new', ...a.data }; }),
      update: jest.fn(async (a: any) => { writes.push(a); return { id: 'p1', ...a.data }; }),
      delete: jest.fn(async () => ({})),
    },
  };
  const audit = { record: jest.fn(async () => undefined) };
  return { svc: new SchedulerPolicyService(prisma as never, audit as never), writes, audit };
}

describe('creating a policy', () => {
  it('requires a name', async () => {
    const { svc } = build();
    await expect(svc.create({ name: '   ' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires a target for a non-global scope', async () => {
    const { svc } = build();
    await expect(svc.create({ name: 'n', scopeType: 'library' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a scope id on a global policy', async () => {
    // Global means everything; naming a target as well is a contradiction the
    // resolver would silently ignore.
    const { svc } = build();
    await expect(svc.create({ name: 'n', scopeType: 'global', scopeId: 'lib1' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown scope', async () => {
    const { svc } = build();
    await expect(svc.create({ name: 'n', scopeType: 'planet' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects zero as a limit', async () => {
    /*
     * "Allow zero downloads" reads like a way to stop the queue, but it is
     * indistinguishable from a typo and would pause every torrent on the engine.
     * Pausing is the honest verb for that.
     */
    const { svc } = build();
    await expect(svc.create({ name: 'n', maxConcurrentDownloads: 0 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a fractional limit', async () => {
    const { svc } = build();
    await expect(svc.create({ name: 'n', maxTotalActive: 2.5 }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a real limit and audits it', async () => {
    const { svc, writes, audit } = build();
    await svc.create({ name: 'Nightly', maxConcurrentDownloads: 3 }, 'u1');
    expect(writes[0].data.maxConcurrentDownloads).toBe(3);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'torrent_scheduler.policy_created' }),
    );
  });
});

describe('updating a policy', () => {
  it('leaves an untouched limit alone rather than clearing it', async () => {
    // `undefined` must reach Prisma as omitted. If it were written as null, every
    // edit that did not mention a field would silently make it unlimited.
    const { svc, writes } = build();
    await svc.update('p1', { name: 'renamed' });
    expect(writes[0].data.maxConcurrentDownloads).toBeUndefined();
    expect(writes[0].data.name).toBe('renamed');
  });

  it('writes an explicit null when the operator clears a limit', async () => {
    // The other half: null is a decision — unlimited — and stops inheritance.
    const { svc, writes } = build();
    await svc.update('p1', { maxConcurrentSeeds: null });
    expect(writes[0].data.maxConcurrentSeeds).toBeNull();
  });

  it('still validates the scope on an edit', async () => {
    const { svc } = build();
    await expect(svc.update('p1', { scopeType: 'engine', scopeId: null }))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});
