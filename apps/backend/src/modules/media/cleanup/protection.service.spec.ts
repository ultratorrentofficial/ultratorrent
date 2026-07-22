import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProtectionService } from './protection.service';

const audit = { record: jest.fn() } as any;
const eventBus = { emit: jest.fn() } as any;

/** Minimal in-memory double for the calls the service makes. */
class FakePrisma {
  rows: any[] = [];
  private seq = 0;
  mediaCleanupProtection = {
    create: async ({ data }: any) => { const r = { id: `p${++this.seq}`, createdAt: new Date(), revokedAt: null, ...data }; this.rows.push(r); return r; },
    findUnique: async ({ where }: any) => this.rows.find((r) => r.id === where.id) ?? null,
    findMany: async () => this.rows.filter((r) => !r.revokedAt),
    update: async ({ where, data }: any) => { const r = this.rows.find((x) => x.id === where.id); Object.assign(r, data); return r; },
    count: async () => this.rows.length,
  };
}

const user = (perms: string[] = []): any => ({ id: 'u1', username: 'op', roles: [], permissions: perms });
const LEGAL = 'library_cleanup.protection.legal_hold';

const base = { targetType: 'media_file', protectionType: 'permanent', reason: 'keeper', mediaFileId: 'f1' } as any;

function make() {
  const prisma = new FakePrisma();
  return { prisma, svc: new ProtectionService(prisma as any, audit, eventBus) };
}

describe('ProtectionService.create — shape validation', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates a well-formed protection and audits it', async () => {
    const { svc } = make();
    const row = await svc.create(base, user());
    expect(row.mediaFileId).toBe('f1');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'library_cleanup.protection.created' }),
    );
  });

  // A protection missing its scope field would silently protect nothing — the most
  // dangerous possible outcome for a safety registry.
  it('refuses a target type without its required id', async () => {
    const { svc } = make();
    await expect(svc.create({ ...base, mediaFileId: undefined }, user())).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ targetType: 'library', protectionType: 'permanent', reason: 'x' } as any, user()))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires seasonNumber for a season and both numbers for an episode', async () => {
    const { svc } = make();
    await expect(svc.create({ targetType: 'season', protectionType: 'permanent', reason: 'x', mediaShowId: 's1' } as any, user()))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ targetType: 'episode', protectionType: 'permanent', reason: 'x', mediaShowId: 's1', seasonNumber: 1 } as any, user()))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a watchlist protection with no id (its scope is the watchlist itself)', async () => {
    const { svc } = make();
    await expect(svc.create({ targetType: 'watchlist', protectionType: 'permanent', reason: 'x' } as any, user())).resolves.toBeDefined();
  });

  it('requires a future deadline for a temporary protection', async () => {
    const { svc } = make();
    await expect(svc.create({ ...base, protectionType: 'temporary' }, user())).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.create({ ...base, protectionType: 'temporary', protectedUntil: '2000-01-01T00:00:00Z' }, user()))
      .rejects.toBeInstanceOf(BadRequestException);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await expect(svc.create({ ...base, protectionType: 'temporary', protectedUntil: future }, user())).resolves.toBeDefined();
  });

  it('requires a conditionKind for a conditional protection', async () => {
    const { svc } = make();
    await expect(svc.create({ ...base, protectionType: 'conditional' }, user())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires an absolute pathPrefix', async () => {
    const { svc } = make();
    await expect(svc.create({ targetType: 'path_prefix', protectionType: 'permanent', reason: 'x', pathPrefix: 'relative/dir' } as any, user()))
      .rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('legal hold — defense in depth', () => {
  beforeEach(() => jest.clearAllMocks());

  // The route guard is not the only check: a workflow/job path could reach the
  // service without traversing the controller.
  it('refuses to CREATE a legal hold without the dedicated permission', async () => {
    const { svc } = make();
    await expect(svc.create({ ...base, protectionType: 'legal_hold' }, user())).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.create({ ...base, protectionType: 'legal_hold' }, user([LEGAL]))).resolves.toBeDefined();
  });

  it('refuses to REVOKE a legal hold without the dedicated permission', async () => {
    const { svc } = make();
    const row = await svc.create({ ...base, protectionType: 'legal_hold' }, user([LEGAL]));
    await expect(svc.revoke(row.id, 'no longer needed', user(['library_cleanup.protection.revoke'])))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.revoke(row.id, 'released', user([LEGAL]))).resolves.toBeDefined();
  });

  it('audits legal-hold creation and revocation distinctly', async () => {
    const { svc } = make();
    const row = await svc.create({ ...base, protectionType: 'legal_hold' }, user([LEGAL]));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'library_cleanup.protection.legal_hold_created' }),
    );
    await svc.revoke(row.id, 'released', user([LEGAL]));
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'library_cleanup.protection.legal_hold_revoked' }),
    );
  });
});

describe('revocation is not deletion', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stamps the row rather than removing it, preserving history', async () => {
    const { prisma, svc } = make();
    const row = await svc.create(base, user());
    await svc.revoke(row.id, 'operator changed their mind', user());
    expect(prisma.rows).toHaveLength(1); // still there
    expect(prisma.rows[0].revokedAt).toBeInstanceOf(Date);
    expect(prisma.rows[0].revokeReason).toBe('operator changed their mind');
    expect(prisma.rows[0].revokedByUserId).toBe('u1');
  });

  it('refuses to revoke twice', async () => {
    const { svc } = make();
    const row = await svc.create(base, user());
    await svc.revoke(row.id, 'first', user());
    await expect(svc.revoke(row.id, 'again', user())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s an unknown protection', async () => {
    const { svc } = make();
    await expect(svc.get('nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('bulk create reports partial outcomes honestly', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates the good ones and names the ones that failed', async () => {
    const { svc } = make();
    const res = await svc.bulkCreate({
      protections: [
        base,
        { ...base, mediaFileId: undefined }, // invalid
        { ...base, mediaFileId: 'f2' },
      ] as any,
    }, user());
    expect(res.created).toBe(2);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].index).toBe(1);
  });
});

describe('evaluate delegates to the pure matcher', () => {
  beforeEach(() => jest.clearAllMocks());

  it('reports a protected target with its matching rule', async () => {
    const { svc } = make();
    await svc.create(base, user());
    const v = await svc.evaluate({ mediaFileId: 'f1' });
    expect(v.isProtected).toBe(true);
    expect(v.matches[0].scope).toBe('file');
  });

  it('reports an unprotected target', async () => {
    const { svc } = make();
    await svc.create(base, user());
    expect((await svc.evaluate({ mediaFileId: 'other' })).isProtected).toBe(false);
  });
});
