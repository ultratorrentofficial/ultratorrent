/**
 * The intake workflow engine.
 *
 * What is pinned here is what makes the pipeline trustworthy rather than merely
 * functional: a duplicate trigger must not import twice, an illegal transition
 * must be refused rather than recorded, a retry must resume where it stopped,
 * and no state change may exist without the event that explains it.
 */
import { MediaIntakeService } from './media-intake.service';
import { StorageProfileService } from './storage-profile.service';
import { BadRequestException } from '@nestjs/common';

function buildIntake(job: Record<string, unknown> | null = null) {
  const events: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const tx = {
    mediaIntakeJob: {
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        return { ...job, ...a.data };
      }),
    },
    mediaIntakeEvent: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        events.push(a.data);
        return a.data;
      }),
    },
  };
  const prisma = {
    mediaIntakeJob: {
      findUnique: jest.fn(async () => job),
      create: jest.fn(async (a: { data: Record<string, unknown> }) => ({ id: 'j1', ...a.data })),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        return { ...job, ...a.data };
      }),
      findMany: jest.fn(async () => []),
      groupBy: jest.fn(async () => [
        { state: 'importing', _count: { _all: 2 } },
        { state: 'seeding', _count: { _all: 5 } },
        { state: 'archived', _count: { _all: 9 } },
      ]),
    },
    mediaIntakeEvent: tx.mediaIntakeEvent,
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const svc = new MediaIntakeService(prisma as never);
  jest.spyOn((svc as never as { logger: { debug: (m: string) => void } }).logger, 'debug')
    .mockImplementation(() => undefined);
  return { svc, prisma, events, updates };
}

const jobAt = (state: string, over: Record<string, unknown> = {}) => ({
  id: 'j1', state, resumeState: null, attempts: 0, lastError: null,
  startedAt: null, importedAt: null, ...over,
});

describe('enqueue idempotency', () => {
  it('creates one intake for a new payload', async () => {
    const { svc, prisma } = buildIntake(null);
    await svc.enqueue({ profileId: 'p1', sourcePath: '/staging/x', torrentHash: 'abc' });
    expect(prisma.mediaIntakeJob.create).toHaveBeenCalled();
  });

  it('returns the existing intake instead of importing twice', async () => {
    /*
     * `torrent.completed` is edge-fired, but an edge can be re-observed after a
     * restart rebuilds the snapshot baseline. A second intake for the same
     * payload would import it a second time.
     */
    const { svc, prisma } = buildIntake(jobAt('imported'));
    const out = await svc.enqueue({ profileId: 'p1', sourcePath: '/staging/x', torrentHash: 'abc' });
    expect(prisma.mediaIntakeJob.create).not.toHaveBeenCalled();
    expect(out.state).toBe('imported');
  });

  it('treats a duplicate as a no-op, not an error', async () => {
    // A duplicate trigger is not a failure; it is the same work already running.
    const { svc } = buildIntake(jobAt('verified'));
    await expect(svc.enqueue({ profileId: 'p1', sourcePath: '/x', torrentHash: 'a' }))
      .resolves.toBeDefined();
  });

  it('keys on the path as well as the hash', async () => {
    /*
     * The same torrent can legitimately be imported into two profiles — a 4K and
     * a 1080p library — and keying on the hash alone would make the second look
     * like a duplicate of the first.
     */
    const { svc, prisma } = buildIntake(null);
    await svc.enqueue({ profileId: 'p1', sourcePath: '/staging/a', torrentHash: 'abc', engineId: 'e1' });
    const key = (prisma.mediaIntakeJob.create.mock.calls[0][0] as { data: { idempotencyKey: string } })
      .data.idempotencyKey;
    expect(key).toContain('abc');
    expect(key).toContain('/staging/a');
  });

  it('starts at completed, because the download already finished', async () => {
    /*
     * `completed` describes the DOWNLOAD, and every route in has one already
     * done — the trigger fires on `torrent.completed`, a manual enqueue names
     * an existing path. Starting at `queued` made the engine look for a stage
     * to produce `completed`, which no stage can: it is a fact, not work. Every
     * intake stopped at step one, which only a live run revealed.
     */
    const { svc, prisma, events } = buildIntake(null);
    await svc.enqueue({ profileId: 'p1', sourcePath: '/x' });
    const created = (prisma.mediaIntakeJob.create.mock.calls[0][0] as { data: { state: string } }).data;
    expect(created.state).toBe('completed');
    expect(events[0]).toMatchObject({ toState: 'completed' });
  });
});

describe('transitions', () => {
  it('advances along the lifecycle', async () => {
    const { svc, updates } = buildIntake(jobAt('verified'));
    await svc.transition('j1', 'identified');
    expect(updates[0]).toMatchObject({ state: 'identified' });
  });

  it('refuses an illegal move rather than recording it', async () => {
    /*
     * The timeline is the evidence an operator reasons from. One containing
     * impossible moves — imported without ever being identified — cannot be
     * reasoned about at all.
     */
    const { svc, updates } = buildIntake(jobAt('verified'));
    await expect(svc.transition('j1', 'imported')).rejects.toThrow(/Illegal intake transition/);
    expect(updates).toHaveLength(0);
  });

  it('writes the state and its event together', async () => {
    // A state without its event is a timeline with a hole, and the hole is
    // always at the moment something went wrong.
    const { svc, prisma, events } = buildIntake(jobAt('completed'));
    await svc.transition('j1', 'verified', { message: 'checksum ok' });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(events[0]).toMatchObject({ fromState: 'completed', toState: 'verified', message: 'checksum ok' });
  });

  it('remembers where a failure happened', async () => {
    const { svc, updates } = buildIntake(jobAt('artwork_ready'));
    await svc.transition('j1', 'failed', { message: 'provider timeout' });
    expect(updates[0]).toMatchObject({ resumeState: 'artwork_ready', lastError: 'provider timeout' });
  });

  it('clears the error when moving off failed', async () => {
    const { svc, updates } = buildIntake(jobAt('failed', { lastError: 'boom', resumeState: 'identified' }));
    await svc.transition('j1', 'identified');
    expect(updates[0]).toMatchObject({ lastError: null });
  });

  it('records who forced a transition', async () => {
    const { svc, events } = buildIntake(jobAt('quarantined'));
    await svc.transition('j1', 'verified', { userId: 'u1', message: 'released' });
    expect(events[0]).toMatchObject({ userId: 'u1' });
  });
});

describe('retry', () => {
  it('resumes at the state that failed', async () => {
    // Retrying from the start would re-fetch metadata and artwork that already
    // succeeded — slow, and rude to every provider involved.
    const { svc, updates } = buildIntake(jobAt('failed', { resumeState: 'metadata_ready', attempts: 1 }));
    await svc.retry('j1');
    expect(updates.some((u) => u.state === 'metadata_ready')).toBe(true);
  });

  it('counts the attempt', async () => {
    const { svc, updates } = buildIntake(jobAt('failed', { resumeState: 'verified', attempts: 2 }));
    await svc.retry('j1');
    expect(updates[0]).toMatchObject({ attempts: { increment: 1 } });
  });

  it('refuses to retry something that has not failed', async () => {
    const { svc } = buildIntake(jobAt('importing'));
    await expect(svc.retry('j1')).rejects.toThrow(/Only a failed intake/);
  });

  it('falls back to completed when no resume point was recorded', async () => {
    // Rows written before resumeState existed, or a failure at queue time.
    const { svc, updates } = buildIntake(jobAt('failed', { resumeState: null }));
    await svc.retry('j1');
    expect(updates.some((u) => u.state === 'completed')).toBe(true);
  });
});

describe('dashboard summary', () => {
  it('counts active work without seeding or archived', async () => {
    // Seeding is indefinite and healthy; counting it would leave the queue
    // permanently non-empty and the number meaningless.
    const { svc } = buildIntake();
    const out = await svc.summary();
    expect(out.active).toBe(2);
    expect(out.byState.seeding).toBe(5);
  });
});

describe('storage profile validation', () => {
  function buildProfiles(libraries: Array<{ name: string; path: string }> = []) {
    // Declared in two steps: `$transaction` hands the same object back to the
    // callback, which TypeScript cannot type inside its own initializer.
    const prisma: Record<string, unknown> = {
      storageProfile: {
        findUnique: jest.fn(async () => ({ id: 'p1', stagingRoot: '/media/staging' })),
        create: jest.fn(async (a: { data: unknown }) => a.data),
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({})),
        update: jest.fn(async (a: { data: unknown }) => a.data),
        delete: jest.fn(async () => ({})),
        findFirst: jest.fn(async () => null),
      },
      mediaLibrary: { findMany: jest.fn(async () => libraries) },
      rssRule: { count: jest.fn(async () => 0) },
    };
    prisma.$transaction = jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(prisma));
    return {
      svc: new StorageProfileService(prisma as never),
      prisma: prisma as unknown as {
        storageProfile: Record<string, jest.Mock>;
        rssRule: { count: jest.Mock };
      },
    };
  }

  const input = (over: Record<string, unknown> = {}) => ({
    name: 'Default', stagingRoot: '/media/staging', ...over,
  });

  it('refuses staging inside a destination library', async () => {
    /*
     * The operational hazard the whole staging design exists to avoid: a scanner
     * pointed at the library would index half-written files, and a partially
     * copied episode that gets matched and renamed is very hard to unpick.
     */
    const { svc } = buildProfiles([{ name: 'TV', path: '/media' }]);
    await expect(svc.create(input({ tvLibraryId: 'lib-1' })))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a library inside staging', async () => {
    const { svc } = buildProfiles([{ name: 'TV', path: '/media/staging/tv' }]);
    await expect(svc.create(input({ tvLibraryId: 'lib-1' })))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows a sibling directory', async () => {
    // `/media/staging-old` is not inside `/media/staging`.
    const { svc } = buildProfiles([{ name: 'TV', path: '/media/staging-old' }]);
    await expect(svc.create(input({ tvLibraryId: 'lib-1' }))).resolves.toBeDefined();
  });

  it('allows the documented layout', async () => {
    // Staging beside the libraries, both under a parent nothing scans.
    const { svc } = buildProfiles([{ name: 'TV', path: '/mnt/media/TV Shows' }]);
    await expect(svc.create(input({ stagingRoot: '/mnt/media/Staging', tvLibraryId: 'lib-1' })))
      .resolves.toBeDefined();
  });

  it('requires an absolute staging root', async () => {
    const { svc } = buildProfiles();
    await expect(svc.create(input({ stagingRoot: 'staging' })))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an unknown strategy', async () => {
    const { svc } = buildProfiles();
    await expect(svc.create(input({ defaultStrategy: 'teleport' })))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('demotes the previous default in the same transaction', async () => {
    // Two defaults means an install picks one arbitrarily and imports diverge.
    const { svc, prisma } = buildProfiles();
    await svc.create(input({ isDefault: true }));
    expect(prisma.storageProfile.updateMany).toHaveBeenCalledWith({
      where: { isDefault: true }, data: { isDefault: false },
    });
  });

  it('refuses to delete a profile rules still point at', async () => {
    // The FK is SetNull, so deleting would silently strand managed rules on a
    // default naming entirely different libraries.
    const { svc, prisma } = buildProfiles();
    prisma.rssRule.count.mockResolvedValue(3 as never);
    await expect(svc.remove('p1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
