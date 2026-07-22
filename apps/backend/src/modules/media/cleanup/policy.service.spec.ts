import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { POLICY_DOCUMENT_SCHEMA_VERSION, type CleanupPolicyDocument } from './domain/policy-document';
import { policyChecksum } from './domain/policy-checksum';

const audit = { record: jest.fn() } as any;
const user = { id: 'u1', username: 'op', roles: [], permissions: [] } as any;

const validDoc = (over: Partial<CleanupPolicyDocument> = {}): CleanupPolicyDocument => ({
  schemaVersion: POLICY_DOCUMENT_SCHEMA_VERSION,
  scope: { libraryKinds: ['movie'] },
  conditions: {
    type: 'all',
    children: [{ type: 'condition', field: 'metadata.releaseYear', operator: 'lt', value: 2001 }],
  },
  exclusions: {
    protected: true, locked: true, activePlayback: true,
    incompleteDownload: true, inFlightOperation: true,
    addedWithinDays: 90, ambiguousIdentity: true, requireMeasuredTechnical: true,
  },
  action: { mode: 'report_only', destination: 'trash' },
  ...over,
});

/** In-memory double for exactly the calls PolicyService makes. */
class FakePrisma {
  policies = new Map<string, any>();
  versions = new Map<string, any>();
  private seq = 0;

  mediaCleanupPolicy = {
    create: async ({ data }: any) => { const id = `pol${++this.seq}`; const r = { id, ...data }; this.policies.set(id, r); return r; },
    findUnique: async ({ where }: any) => this.policies.get(where.id) ?? null,
    update: async ({ where, data }: any) => { const r = this.policies.get(where.id); Object.assign(r, data); return r; },
    delete: async ({ where }: any) => { this.policies.delete(where.id); return {}; },
    findMany: async () => [...this.policies.values()],
    count: async () => this.policies.size,
  };
  mediaCleanupPolicyVersion = {
    create: async ({ data }: any) => { const id = `v${++this.seq}`; const r = { id, changeNotes: null, ...data }; this.versions.set(id, r); return r; },
    findUnique: async ({ where }: any) => this.versions.get(where.id) ?? null,
    update: async ({ where, data }: any) => { const r = this.versions.get(where.id); Object.assign(r, data); return r; },
    aggregate: async ({ where }: any) => ({
      _max: { versionNumber: Math.max(0, ...[...this.versions.values()].filter((v) => v.policyId === where.policyId).map((v) => v.versionNumber)) },
    }),
  };
  mediaCleanupRun = { count: async () => 0 };
  $transaction = async (fn: any) => fn(this);
}

function make() {
  const prisma = new FakePrisma();
  return { prisma, svc: new PolicyService(prisma as any, audit) };
}

describe('catalog', () => {
  it('exposes the condition palette, limits and operators', () => {
    const { svc } = make();
    const c = svc.catalog();
    expect(c.conditions.length).toBeGreaterThan(30);
    expect(c.limits.maxConditions).toBeGreaterThan(0);
    expect(c.operators).toContain('matches');
  });
});

describe('create', () => {
  beforeEach(() => jest.clearAllMocks());

  // A new policy must be inert: nothing should be deletable the moment it exists.
  it('starts disabled, report-only, with a draft version 1', async () => {
    const { prisma, svc } = make();
    const p = await svc.create({ name: 'Old movies' }, user);
    expect(p.enabled).toBe(false);
    expect(p.mode).toBe('report_only');
    expect(p.status).toBe('draft');
    expect(p.currentDraftVersionId).toBeTruthy();
    const v = prisma.versions.get(p.currentDraftVersionId!);
    expect(v.versionNumber).toBe(1);
    expect(v.status).toBe('draft');
  });
});

describe('saveDraft', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stores a valid document and marks the policy ready', async () => {
    const { prisma, svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    const res = await svc.saveDraft(p.id, validDoc(), 'first pass', user);
    expect(res.validation.valid).toBe(true);
    expect(prisma.policies.get(p.id).status).toBe('ready');
    expect(res.summary).toBe('metadata.releaseYear < 2001');
  });

  it('records an invalid document as validation_failed rather than rejecting it', async () => {
    const { prisma, svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    const res = await svc.saveDraft(p.id, validDoc({ conditions: { type: 'all', children: [] } }), undefined, user);
    expect(res.validation.valid).toBe(false);
    expect(prisma.policies.get(p.id).status).toBe('validation_failed');
  });

  it('records the fact keys the document reads (drives the input digest)', async () => {
    const { prisma, svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    const res = await svc.saveDraft(p.id, validDoc(), undefined, user);
    expect(prisma.versions.get(res.versionId).factKeys).toEqual(['metadata.releaseYear']);
  });
});

describe('publish — the immutability invariant', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refuses to publish an invalid policy', async () => {
    const { svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    await svc.saveDraft(p.id, validDoc({ conditions: { type: 'all', children: [] } }), undefined, user);
    await expect(svc.publish(p.id, undefined, user)).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('freezes the draft and clears the draft pointer', async () => {
    const { prisma, svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    const { versionId } = await svc.saveDraft(p.id, validDoc(), undefined, user);
    await svc.publish(p.id, 'ship', user);

    const after = prisma.policies.get(p.id);
    expect(after.publishedVersionId).toBe(versionId);
    expect(after.currentDraftVersionId).toBeNull();
    expect(prisma.versions.get(versionId).status).toBe('published');
    expect(prisma.versions.get(versionId).publishedAt).toBeInstanceOf(Date);
  });

  // Publishing arms nothing: a destructive policy must be enabled deliberately.
  it('does not enable the policy', async () => {
    const { prisma, svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    await svc.saveDraft(p.id, validDoc(), undefined, user);
    await svc.publish(p.id, undefined, user);
    expect(prisma.policies.get(p.id).enabled).toBe(false);
  });

  it('refuses to publish with no draft', async () => {
    const { svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    await svc.saveDraft(p.id, validDoc(), undefined, user);
    await svc.publish(p.id, undefined, user);
    await expect(svc.publish(p.id, undefined, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  // The heart of it: editing after publishing must not mutate what is running.
  it('the next edit forks a NEW draft and leaves the published version untouched', async () => {
    const { prisma, svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    const first = await svc.saveDraft(p.id, validDoc(), undefined, user);
    await svc.publish(p.id, undefined, user);
    const publishedChecksum = prisma.versions.get(first.versionId).checksum;

    const second = await svc.saveDraft(p.id, validDoc({
      conditions: { type: 'all', children: [{ type: 'condition', field: 'metadata.releaseYear', operator: 'lt', value: 1990 }] },
    }), undefined, user);

    expect(second.versionId).not.toBe(first.versionId);
    expect(prisma.versions.get(second.versionId).versionNumber).toBe(2);
    // The published version is byte-for-byte what it was.
    expect(prisma.versions.get(first.versionId).checksum).toBe(publishedChecksum);
    expect(prisma.versions.get(first.versionId).status).toBe('published');
    expect(prisma.policies.get(p.id).publishedVersionId).toBe(first.versionId);
  });
});

describe('enable / disable', () => {
  beforeEach(() => jest.clearAllMocks());

  it('refuses to enable an unpublished policy', async () => {
    const { svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    await expect(svc.setEnabled(p.id, true, user)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enables a published policy and is idempotent', async () => {
    const { svc } = make();
    const p = await svc.create({ name: 'x' }, user);
    await svc.saveDraft(p.id, validDoc(), undefined, user);
    await svc.publish(p.id, undefined, user);
    expect((await svc.setEnabled(p.id, true, user)).enabled).toBe(true);
    expect((await svc.setEnabled(p.id, true, user)).enabled).toBe(true);
    expect((await svc.setEnabled(p.id, false, user)).enabled).toBe(false);
  });
});

describe('checksum', () => {
  it('is stable across key order but changes with meaning', () => {
    const a = validDoc();
    const b = JSON.parse(JSON.stringify({ action: a.action, exclusions: a.exclusions, conditions: a.conditions, scope: a.scope, schemaVersion: a.schemaVersion }));
    expect(policyChecksum(b)).toBe(policyChecksum(a));

    const changed = validDoc({
      conditions: { type: 'all', children: [{ type: 'condition', field: 'metadata.releaseYear', operator: 'lt', value: 1990 }] },
    });
    expect(policyChecksum(changed)).not.toBe(policyChecksum(a));
  });

  it('ignores prose that does not change what the policy deletes', () => {
    expect(policyChecksum(validDoc({ notes: 'hello' }))).toBe(policyChecksum(validDoc()));
  });
});
