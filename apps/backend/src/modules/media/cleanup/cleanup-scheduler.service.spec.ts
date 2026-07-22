import { CleanupSchedulerService } from './cleanup-scheduler.service';
import { BREAKER } from './domain/storage-pressure';

jest.mock('node:fs/promises', () => ({
  statfs: jest.fn(async () => ({ blocks: 1000, bsize: 4096, bfree: 100, bavail: 50 })),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { statfs } = require('node:fs/promises') as { statfs: jest.Mock };

const NOW = new Date('2026-07-22T04:00:00Z');

const DOC = {
  schemaVersion: 1,
  scope: {},
  conditions: { type: 'all', children: [] },
  exclusions: { protected: true, locked: true, activePlayback: true, incompleteDownload: true, inFlightOperation: true },
  action: { mode: 'approval_required', destination: 'trash' },
  storagePressure: { enabled: true, triggerBelowFreePercent: 10, stopAtFreePercent: 20 },
};

function makeService(over: {
  policies?: Array<Record<string, unknown>>;
  document?: Record<string, unknown> | null;
  runStatus?: string;
  startThrows?: boolean;
  hardRoots?: string[];
} = {}) {
  const prisma = {
    mediaCleanupPolicy: {
      findMany: jest.fn(async () => over.policies ?? []),
      update: jest.fn(async () => ({})),
    },
    mediaCleanupPolicyVersion: {
      findUnique: jest.fn(async () => over.document === undefined ? { id: 'v1', document: DOC } : (over.document && { id: 'v1', document: over.document })),
    },
    mediaCleanupRun: {
      findUnique: jest.fn(async () => ({ status: over.runStatus ?? 'completed' })),
    },
    mediaLibrary: { findMany: jest.fn(async () => [{ path: '/media/TV' }]) },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const paths = {
    hardRoots: over.hardRoots ?? ['/media'],
    assertWithinHardRoots: jest.fn((p: string) => p),
  };
  const discovery = {
    startRun: jest.fn(async (_policyId: string, _opts: { simulate: boolean; trigger: string }) => {
      if (over.startThrows) throw new Error('policy is disabled');
      return { id: 'run-1' };
    }),
    executeRun: jest.fn(async () => undefined),
  };
  const eventBus = { emit: jest.fn() };

  const service = new CleanupSchedulerService(
    prisma as never, audit as never, paths as never, discovery as never, eventBus as never,
  );
  return { service, prisma, audit, discovery, eventBus };
}

const cronPolicy = (over: Record<string, unknown> = {}) => ({
  id: 'p1', enabled: true, scheduleCron: '0 3 * * *', publishedVersionId: 'v1',
  lastRunAt: new Date('2026-07-21T03:00:00Z'), freeSpaceTriggerPercent: null, ...over,
});

const pressurePolicy = (over: Record<string, unknown> = {}) => ({
  id: 'p2', enabled: true, scheduleCron: null, publishedVersionId: 'v1',
  lastRunAt: null, freeSpaceTriggerPercent: 10, ...over,
});

afterEach(() => jest.clearAllMocks());

describe('scheduled runs', () => {
  it('fires a policy whose nightly firing has elapsed since its last run', async () => {
    const h = makeService({ policies: [cronPolicy()] });
    expect(await h.service.runScheduled(NOW)).toBe(1);
    expect(h.discovery.startRun).toHaveBeenCalledWith('p1', expect.objectContaining({
      simulate: false, trigger: 'scheduled',
    }));
  });

  it('does not fire twice for the same firing', async () => {
    const h = makeService({ policies: [cronPolicy({ lastRunAt: new Date('2026-07-22T03:30:00Z') })] });
    expect(await h.service.runScheduled(NOW)).toBe(0);
  });

  // Publishing and enabling are separate acts; an unpublished policy has no
  // immutable version to pin, so there is nothing legitimate to run.
  it('never runs an unpublished policy', async () => {
    const h = makeService({ policies: [cronPolicy({ publishedVersionId: null })] });
    expect(await h.service.runScheduled(NOW)).toBe(0);
    expect(h.discovery.startRun).not.toHaveBeenCalled();
  });

  it('one unparseable schedule does not stop the others', async () => {
    const h = makeService({
      policies: [cronPolicy({ id: 'bad', scheduleCron: 'every other tuesday' }), cronPolicy({ id: 'good' })],
    });
    expect(await h.service.runScheduled(NOW)).toBe(1);
    expect(h.discovery.startRun).toHaveBeenCalledWith('good', expect.anything());
  });

  it('records when it last ran, so the next tick does not repeat it', async () => {
    const h = makeService({ policies: [cronPolicy()] });
    await h.service.runScheduled(NOW);
    expect(h.prisma.mediaCleanupPolicy.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'p1' } }),
    );
  });

  // Everything the scheduler fires is a DISCOVERY run.
  it('never approves or executes anything', async () => {
    const h = makeService({ policies: [cronPolicy()] });
    await h.service.runScheduled(NOW);
    expect(h.discovery.executeRun).toHaveBeenCalled();
    expect(h.discovery.startRun.mock.calls[0]![1]).toMatchObject({ simulate: false });
  });
});

describe('storage pressure', () => {
  it('fires when free space is below the trigger', async () => {
    // bavail 50 of 1000 blocks = 5% free, under the 10% trigger.
    const h = makeService({ policies: [pressurePolicy()] });
    expect(await h.service.runStoragePressure(NOW)).toBe(1);
    expect(h.discovery.startRun).toHaveBeenCalledWith('p2', expect.objectContaining({
      trigger: 'storage_pressure',
    }));
  });

  it('does not fire when there is room', async () => {
    statfs.mockResolvedValue({ blocks: 1000, bsize: 4096, bfree: 900, bavail: 850 });
    const h = makeService({ policies: [pressurePolicy()] });
    expect(await h.service.runStoragePressure(NOW)).toBe(0);
  });

  // The denormalized column is only a selector; the immutable document decides.
  it('ignores a stale trigger column when the published document has pressure off', async () => {
    const h = makeService({
      policies: [pressurePolicy()],
      document: { ...DOC, storagePressure: { enabled: false, triggerBelowFreePercent: 10 } },
    });
    expect(await h.service.runStoragePressure(NOW)).toBe(0);
  });

  it('does not fire when free space cannot be read at all', async () => {
    statfs.mockRejectedValue(new Error('ENOENT'));
    const h = makeService({ policies: [pressurePolicy()] });
    expect(await h.service.runStoragePressure(NOW)).toBe(0);
  });

  it('reads availability, not the root-reserved figure', async () => {
    // bfree 150 (15%, above trigger) but bavail 50 (5%, below): the honest number
    // is what this process can actually use.
    statfs.mockResolvedValue({ blocks: 1000, bsize: 4096, bfree: 150, bavail: 50 });
    const h = makeService({ policies: [pressurePolicy()] });
    expect(await h.service.runStoragePressure(NOW)).toBe(1);
  });

  it('takes the tightest reading when a policy spans filesystems', async () => {
    statfs
      .mockResolvedValueOnce({ blocks: 1000, bsize: 4096, bfree: 900, bavail: 900 })
      .mockResolvedValueOnce({ blocks: 1000, bsize: 4096, bfree: 20, bavail: 20 });
    const h = makeService({ hardRoots: ['/media/a', '/media/b'] });
    const r = await h.service.readFreeSpace(['/media/a', '/media/b']);
    expect(r!.freePercent).toBeCloseTo(2);
  });
});

describe('the circuit breaker', () => {
  it('pauses automatic runs after repeated failures', async () => {
    const h = makeService({ policies: [cronPolicy()], startThrows: true });
    for (let i = 0; i < BREAKER.failureThreshold; i += 1) {
      await h.service.runScheduled(NOW);
    }
    h.discovery.startRun.mockClear();
    await h.service.runScheduled(NOW);
    expect(h.discovery.startRun).not.toHaveBeenCalled();
  });

  it('counts a run that finished FAILED, not only a thrown one', async () => {
    const h = makeService({ policies: [cronPolicy({ lastRunAt: null })], runStatus: 'failed' });
    for (let i = 0; i < BREAKER.failureThreshold; i += 1) {
      await h.service.runScheduled(NOW);
    }
    h.discovery.startRun.mockClear();
    await h.service.runScheduled(NOW);
    expect(h.discovery.startRun).not.toHaveBeenCalled();
  });

  it('a successful run keeps the breaker closed', async () => {
    const h = makeService({ policies: [cronPolicy({ lastRunAt: null })] });
    for (let i = 0; i < BREAKER.failureThreshold + 2; i += 1) {
      await h.service.runScheduled(NOW);
    }
    h.discovery.startRun.mockClear();
    await h.service.runScheduled(NOW);
    expect(h.discovery.startRun).toHaveBeenCalled();
  });
});

describe('the tick', () => {
  it('never throws out of the scheduler', async () => {
    const h = makeService();
    h.prisma.mediaCleanupPolicy.findMany.mockRejectedValue(new Error('db gone'));
    await expect(h.service.tick()).resolves.toBeUndefined();
  });
});
