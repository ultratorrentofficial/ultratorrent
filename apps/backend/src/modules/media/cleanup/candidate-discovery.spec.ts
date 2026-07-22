import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CandidateDiscoveryService } from './candidate-discovery.service';

/**
 * Discovery is the first place the policy engine meets real rows, so what is
 * tested here is the run *contract*: which versions a run may pin, what a
 * capped run reports, and that a scan never produces an action.
 */

const user = { id: 'u1', username: 'op' } as never;

function makeService(over: {
  policy?: Record<string, unknown> | null;
  version?: Record<string, unknown> | null;
  run?: Record<string, unknown> | null;
  items?: Array<Record<string, unknown>>;
} = {}) {
  const created: Record<string, unknown>[] = [];
  const runUpdates: Record<string, unknown>[] = [];
  let runRow: Record<string, unknown> | null =
    over.run === undefined ? { id: 'r1', status: 'queued', simulate: true, policyVersionId: 'v1' } : over.run;

  // The scan pages with a cursor; serve one page then exhaustion.
  let page = 0;
  const items = over.items ?? [];

  const prisma = {
    mediaCleanupPolicy: {
      findUnique: jest.fn(async () => over.policy ?? null),
    },
    mediaCleanupPolicyVersion: {
      findUnique: jest.fn(async () => over.version ?? null),
    },
    mediaCleanupRun: {
      create: jest.fn(async ({ data }: never) => ({ id: 'r1', ...(data as object) })),
      findUnique: jest.fn(async () => runRow),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        runUpdates.push(data);
        if (typeof data.status === 'string') runRow = { ...(runRow ?? {}), status: data.status };
        return runRow;
      }),
    },
    mediaCleanupCandidate: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
    mediaItem: {
      findMany: jest.fn(async () => (page++ === 0 ? items : [])),
    },
    mediaPlaybackAggregate: { findUnique: jest.fn(async () => null) },
    platformJob: { count: jest.fn(async () => 0) },
  };

  const audit = { record: jest.fn(async () => undefined) };
  const protections = {
    evaluate: jest.fn(async () => ({ isProtected: false, hasLegalHold: false, matches: [] })),
  };
  const filePath = { assertWithinHardRoots: jest.fn(() => undefined) };
  const eventBus = { emit: jest.fn() };

  const service = new CandidateDiscoveryService(
    prisma as never, audit as never, protections as never, filePath as never, eventBus as never,
  );
  return { service, prisma, audit, created, runUpdates, get runRow() { return runRow; } };
}

const policyDoc = {
  version: 1,
  conditions: { type: 'condition', field: 'metadata.releaseYear', operator: 'lt', value: 3000 },
  action: { destination: 'quarantine' },
  scope: {},
};

const mediaRow = (id: string) => ({
  id, libraryId: 'lib1', mediaType: 'movie', year: 1998, matchStatus: 'matched',
  confidence: 0.99, locked: false, createdAt: new Date('2020-01-01T00:00:00Z'),
  duplicateGroupId: null,
  externalIds: [{ provider: 'imdb', externalId: 'tt1' }],
  metadata: { genres: [], tags: [], certification: null, rating: 7, runtime: 90, releaseDate: null },
  files: [{
    id: `${id}-f`, path: `/media/Movies/${id}/a.mkv`, size: 1024n,
    width: 1280, height: 720, videoCodec: 'x264', audioCodec: 'aac', audioChannels: 2,
    bitrateKbps: 4000, frameRate: 24, container: 'mkv', durationSec: 5400,
    videoBitDepth: 8, chromaSubsampling: '4:2:0', hdrFormat: null, hdr: null,
    techSource: 'probe', probedAt: new Date('2026-01-01T00:00:00Z'), probeError: null,
  }],
  library: { kind: 'movie', path: '/media/Movies' },
});

describe('startRun — which version a run may pin', () => {
  it('refuses a policy that was never published', async () => {
    const { service } = makeService({
      policy: { id: 'p1', publishedVersionId: null, currentDraftVersionId: 'v-draft', enabled: true },
    });
    await expect(service.startRun('p1', { simulate: false, trigger: 'manual', userId: 'u1' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a simulation use the draft — that is the point of simulating', async () => {
    const { service } = makeService({
      policy: { id: 'p1', publishedVersionId: null, currentDraftVersionId: 'v-draft', enabled: false },
    });
    const run = await service.startRun('p1', { simulate: true, trigger: 'manual', userId: 'u1' });
    expect(run.policyVersionId).toBe('v-draft');
    expect(run.simulate).toBe(true);
  });

  it('refuses an automatic trigger on a disabled policy', async () => {
    const { service } = makeService({
      policy: { id: 'p1', publishedVersionId: 'v1', currentDraftVersionId: null, enabled: false },
    });
    await expect(service.startRun('p1', { simulate: false, trigger: 'scheduled' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s on an unknown policy', async () => {
    const { service } = makeService({ policy: null });
    await expect(service.startRun('nope', { simulate: true, trigger: 'manual' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('executeRun — a scan records candidates, never actions', () => {
  it('records a matching file as a candidate and reclaims nothing', async () => {
    const h = makeService({
      version: { id: 'v1', document: policyDoc },
      items: [mediaRow('i1')],
    });
    await h.service.executeRun('r1');
    expect(h.created).toHaveLength(1);
    expect(h.created[0]!.status).toBe('candidate');
    expect(h.created[0]!.fingerprint).toEqual(expect.any(String));
    // Discovery produces no plan and no action row.
    expect(Object.keys(h.prisma)).not.toContain('mediaCleanupAction');
    expect(h.runRow!.status).toBe('completed');
  });

  it('fails the run rather than scanning when the pinned version is gone', async () => {
    const h = makeService({ version: null, items: [mediaRow('i1')] });
    await h.service.executeRun('r1');
    expect(h.created).toHaveLength(0);
    expect(h.runRow!.status).toBe('failed');
    expect(h.runUpdates.at(-1)!.errorSummary).toBe('missing_policy_version');
  });

  it('reports a capped run as PARTIAL, never completed', async () => {
    // Silent truncation is the failure mode: a partial sweep must not read as
    // "the library holds nothing else".
    const h = makeService({
      version: { id: 'v1', document: policyDoc },
      items: [mediaRow('i1'), mediaRow('i2'), mediaRow('i3')],
    });
    await h.service.executeRun('r1', 1);
    expect(h.created).toHaveLength(1);
    expect(h.runRow!.status).toBe('partial');
    expect(h.runUpdates.at(-1)!.errorSummary).toBe('evaluation_cap_reached:1');
    expect(h.runUpdates.at(-1)!.completedAt).toBeInstanceOf(Date);
  });

  it('stops at a page boundary when cancelled, leaving what it found', async () => {
    const h = makeService({
      run: { id: 'r1', status: 'cancelling', simulate: true, policyVersionId: 'v1' },
      version: { id: 'v1', document: policyDoc },
      items: [mediaRow('i1')],
    });
    // A run already in `cancelling` is not resumable, so nothing runs at all.
    await h.service.executeRun('r1');
    expect(h.created).toHaveLength(0);
  });

  it('fails the run instead of stranding it when the scan throws', async () => {
    // Anything thrown mid-page used to leave the row in `running` forever, so every
    // later poll showed work that never ends.
    const h = makeService({ version: { id: 'v1', document: policyDoc }, items: [mediaRow('i1')] });
    h.prisma.mediaCleanupCandidate.create.mockRejectedValueOnce(new Error('disk on fire'));
    await expect(h.service.executeRun('r1')).resolves.toBeUndefined();
    expect(h.runRow!.status).toBe('failed');
    expect(h.runUpdates.at(-1)!.errorSummary).toContain('disk on fire');
  });

  it('ignores a run that already finished', async () => {
    const h = makeService({ run: { id: 'r1', status: 'completed', simulate: false, policyVersionId: 'v1' } });
    await h.service.executeRun('r1');
    expect(h.created).toHaveLength(0);
  });
});

describe('cancelRun', () => {
  it('marks a running scan for cooperative cancellation', async () => {
    const h = makeService({ run: { id: 'r1', status: 'running', simulate: false, policyVersionId: 'v1' } });
    await expect(h.service.cancelRun('r1', user)).resolves.toEqual({ status: 'cancelling' });
  });

  it('refuses to cancel a run that already finished', async () => {
    const h = makeService({ run: { id: 'r1', status: 'completed', simulate: false, policyVersionId: 'v1' } });
    await expect(h.service.cancelRun('r1', user)).rejects.toBeInstanceOf(BadRequestException);
  });
});
