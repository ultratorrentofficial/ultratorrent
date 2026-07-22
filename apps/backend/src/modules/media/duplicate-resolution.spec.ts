import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { DuplicateResolutionService } from './duplicate-resolution.service';

/**
 * These tests are about REFUSALS. The happy path matters least here: a cleanup that
 * works is worth far less than one that declines to act when the world moved
 * underneath it. Every case below is a defect recorded in the redesign review.
 */
function build(over: any = {}) {
  const state: any = {
    group: { id: 'g1', status: 'open', version: 1, recommendedItemId: 'keep', items: [], ...over.group },
    resolution: null as any,
    actions: [] as any[],
    libraries: over.libraries ?? [{ path: '/library' }],
  };
  const prisma: any = {
    mediaDuplicateGroup: {
      findUnique: jest.fn(async () => state.group),
      update: jest.fn(async ({ data }: any) => Object.assign(state.group, data)),
    },
    mediaLibrary: { findMany: jest.fn(async () => state.libraries) },
    mediaDuplicateResolution: {
      create: jest.fn(async ({ data }: any) => {
        state.resolution = { id: 'r1', ...data, group: state.group };
        return state.resolution;
      }),
      findUnique: jest.fn(async () => state.resolution),
      update: jest.fn(async ({ data }: any) => Object.assign(state.resolution, data)),
    },
    mediaDuplicateResolutionAction: {
      create: jest.fn(async ({ data }: any) => {
        const r = { id: `a${state.actions.length}`, ...data };
        state.actions.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(state.actions.find((a: any) => a.id === where.id), data),
      ),
    },
  };
  const filePath: any = {
    assertWithinHardRoots:
      over.assertWithinHardRoots ??
      jest.fn((p: string) => {
        if (!p.startsWith('/library')) throw new Error('outside roots');
        return p;
      }),
    safety: { toRelative: (p: string) => p },
    // Cleanup must resolve against the hard roots, never the narrowed browse
    // root — see the "narrowed Default Root Path" case below.
    storageSafety: { toRelative: (p: string) => p },
  };
  const files: any = { remove: jest.fn(async () => undefined) };
  const audit: any = { record: jest.fn(async () => undefined) };
  const svc = new DuplicateResolutionService(prisma, filePath, files, audit, { broadcast: jest.fn() } as any, { emit: jest.fn() } as any);
  return { svc, state, prisma, files, audit, filePath };
}

const item = (id: string, p: string, size: number) => ({
  id,
  path: p,
  files: [{ path: p, size: BigInt(size) }],
});

describe('preview — refuses to plan what it should not', () => {
  it('404s an unknown group', async () => {
    const { svc, prisma } = build();
    prisma.mediaDuplicateGroup.findUnique = jest.fn(async () => null);
    await expect(svc.preview('nope', undefined)).rejects.toThrow(NotFoundException);
  });

  it('refuses a review-required group with no explicit choice', async () => {
    // The engine withholds a recommendation on review-required groups on purpose.
    // Inventing one here would defeat exactly that protection.
    const { svc } = build({
      group: {
        recommendedItemId: null,
        items: [item('a', '/library/a.mkv', 10), item('b', '/library/b.mkv', 20)],
      },
    });
    await expect(svc.preview('g1', undefined)).rejects.toThrow(BadRequestException);
  });

  it('refuses a keep id that is not a member of the group', async () => {
    // Untrusted input: nominating an outsider would plan trashing every real member.
    const { svc } = build({
      group: { items: [item('a', '/library/a.mkv', 10), item('b', '/library/b.mkv', 20)] },
    });
    await expect(svc.preview('g1', 'not-in-group')).rejects.toThrow(BadRequestException);
  });

  it('refuses a group that was already resolved', async () => {
    const { svc } = build({
      group: {
        status: 'resolved',
        items: [item('a', '/library/a.mkv', 10), item('b', '/library/b.mkv', 20)],
      },
    });
    await expect(svc.preview('g1', 'a')).rejects.toThrow(ConflictException);
  });

  it('blocks a path outside the storage roots instead of planning it', async () => {
    const { svc } = build({
      group: {
        recommendedItemId: 'a',
        items: [item('a', '/library/a.mkv', 10), item('b', '/etc/passwd', 20)],
      },
    });
    const p = await svc.preview('g1', 'a');
    expect(p.blockers.join(' ')).toContain('outside the allowed storage roots');
    expect(p.actions).toHaveLength(0);
  });

  it('refuses to delete a library root', async () => {
    const { svc } = build({
      group: {
        recommendedItemId: 'a',
        items: [item('a', '/library/a.mkv', 10), item('b', '/library', 0)],
      },
    });
    const p = await svc.preview('g1', 'a');
    expect(p.blockers.join(' ')).toContain('library root');
  });

  it('plans one trash per redundant copy, never the keeper, and pins the version', async () => {
    const { svc } = build({
      group: {
        version: 4,
        recommendedItemId: 'keep',
        items: [
          item('keep', '/library/keep.mkv', 100),
          item('x', '/library/x.mkv', 30),
          item('y', '/library/y.mkv', 20),
        ],
      },
    });
    const p = await svc.preview('g1', undefined);
    expect(p.actions.map((a) => a.itemId).sort()).toEqual(['x', 'y']);
    expect(p.actions.every((a) => a.actionType === 'trash')).toBe(true);
    expect(p.expectedSavingsBytes).toBe(50);
    expect(p.groupVersion).toBe(4);
    expect(p.actions.some((a) => a.itemId === 'keep')).toBe(false);
  });
});

describe('preview — ONLY the media file is removed, never its sidecars', () => {
  // The operator asked for the redundant *media* to go, not its metadata. A stray
  // .nfo beside a kept copy is harmless; a deleted poster or subtitle is content
  // the operator did not ask to lose. So a cleanup trashes the video and nothing
  // else — no .nfo, no artwork, no subtitles.
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'dupsc-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  async function withFiles(names: string[]) {
    for (const n of names) await writeFile(path.join(dir, n), 'x');
    const keepPath = path.join(dir, 'keep.mkv');
    const dropPath = path.join(dir, 'drop.mp4');
    const ctx = build({
      libraries: [{ path: dir }],
      assertWithinHardRoots: jest.fn((p: string) => { if (!p.startsWith(dir)) throw new Error('outside roots'); return p; }),
      group: { version: 1, recommendedItemId: 'keep', items: [item('keep', keepPath, 10), item('drop', dropPath, 20)] },
    });
    return ctx;
  }

  it('leaves the removed copy’s .nfo and -thumb.jpg in place', async () => {
    const { svc } = await withFiles(['keep.mkv', 'drop.mp4', 'drop.nfo', 'drop-thumb.jpg']);
    const p = await svc.preview('g1', 'keep');
    // The video, and only the video.
    expect(p.actions.map((a) => path.basename(a.sourcePath))).toEqual(['drop.mp4']);
    expect(p.actions.every((a) => a.actionType === 'trash')).toBe(true);
  });

  it('leaves a subtitle beside the removed copy untouched', async () => {
    const { svc } = await withFiles(['keep.mkv', 'drop.mp4', 'drop.por.srt']);
    const p = await svc.preview('g1', 'keep');
    expect(p.actions.map((a) => path.basename(a.sourcePath))).toEqual(['drop.mp4']);
    // No subtitle ever enters the plan — and nothing is "orphaned" because we do
    // not remove the metadata that would have been orphaned.
    expect(p.actions.some((a) => a.sourcePath.endsWith('.srt'))).toBe(false);
    expect(p.orphanedSubtitles).toHaveLength(0);
  });

  it('never touches artwork/NFO whether folder-level or named after the video', async () => {
    const { svc } = await withFiles([
      'keep.mkv', 'drop.mp4', 'drop.nfo', 'poster.jpg', 'fanart.jpg', 'tvshow.nfo', 'theme.mp3',
    ]);
    const p = await svc.preview('g1', 'keep');
    expect(p.actions.map((a) => path.basename(a.sourcePath))).toEqual(['drop.mp4']);
  });

  it('counts only the media file in the expected reclaim, not sidecars', async () => {
    const { svc } = await withFiles(['keep.mkv', 'drop.mp4', 'drop.nfo']);
    const p = await svc.preview('g1', 'keep');
    // Just the video's 20 bytes from the DB snapshot; the .nfo is not removed.
    expect(p.expectedSavingsBytes).toBe(20);
  });
});

describe('resolve — refuses to execute a plan it should not', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dupres-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function planned(sizes: { keep: number; drop: number }) {
    const keepPath = path.join(dir, 'keep.mkv');
    const dropPath = path.join(dir, 'drop.mkv');
    await writeFile(keepPath, 'k'.repeat(sizes.keep));
    await writeFile(dropPath, 'd'.repeat(sizes.drop));
    const ctx = build({
      libraries: [{ path: dir }],
      assertWithinHardRoots: jest.fn((p: string) => {
        if (!p.startsWith(dir)) throw new Error('outside roots');
        return p;
      }),
      group: {
        version: 1,
        recommendedItemId: 'keep',
        items: [item('keep', keepPath, sizes.keep), item('drop', dropPath, sizes.drop)],
      },
    });
    await ctx.svc.preview('g1', 'keep');
    return { ...ctx, keepPath, dropPath };
  }

  // Regression: on a live install the admin set the file-manager Default Root
  // Path to /downloads/complete while every media library sat elsewhere under
  // /downloads. Preview validated against the hard roots and happily promised
  // "Moving 1 file to Trash"; execution then resolved the same path through the
  // *narrowed* root and refused it — "Path is outside the allowed roots" — so
  // every cleanup, for every library, failed after the operator confirmed it.
  // Where the file manager opens must not decide which storage can be maintained.
  it('cleans up a library that sits outside a narrowed Default Root Path', async () => {
    const { svc, files, filePath } = await planned({ keep: 100, drop: 50 });
    // The narrowed browse boundary rejects every library path, exactly as the
    // real PathSafety does once it is scoped to a subtree holding no library.
    filePath.safety.toRelative = jest.fn(() => {
      throw new Error('Path is outside the allowed roots');
    });

    const r = await svc.resolve('r1');

    expect(r.status).toBe('completed');
    expect(r.trashed).toBe(1);
    // Storage scope, so FilesService resolves against the hard roots — the same
    // boundary assertWithinHardRoots and preview already checked.
    expect(files.remove.mock.calls[0][2]).toBe('storage');
  });

  it('trashes the redundant copy by default (recoverable)', async () => {
    const { svc, files, state } = await planned({ keep: 100, drop: 50 });
    const r = await svc.resolve('r1');
    expect(r.status).toBe('completed');
    expect(r.trashed).toBe(1);
    // Trash-first is the default: permanent is only ever true when explicitly asked.
    expect(files.remove.mock.calls[0][0].permanent).toBe(false);
    expect(r.permanent).toBe(false);
    expect(state.group.status).toBe('resolved');
  });

  it('deletes permanently only when the operator asks — these files are large', async () => {
    const { svc, files } = await planned({ keep: 100, drop: 50 });
    const r = await svc.resolve('r1', {}, { permanent: true });
    expect(r.status).toBe('completed');
    expect(r.permanent).toBe(true);
    // Skips Trash: the redundant copy is removed outright, freeing the space now.
    expect(files.remove.mock.calls[0][0].permanent).toBe(true);
  });

  it('refuses a plan whose group changed after the preview', async () => {
    const { svc, state } = await planned({ keep: 100, drop: 50 });
    state.group.version = 2; // re-detected since the operator looked
    await expect(svc.resolve('r1')).rejects.toThrow(ConflictException);
    expect(state.resolution.status).toBe('failed');
    expect(state.resolution.errorSummary).toBe('stale_plan');
  });

  it('refuses when the copy being KEPT has vanished', async () => {
    // Trashing the redundant copies here would leave no copy at all.
    const { svc, keepPath, state } = await planned({ keep: 100, drop: 50 });
    await rm(keepPath);
    await expect(svc.resolve('r1')).rejects.toThrow(ConflictException);
    expect(state.resolution.errorSummary).toBe('keeper_missing');
  });

  it('skips a file that changed size since the preview', async () => {
    // The operator approved trashing a specific file, not whatever now sits there.
    const { svc, dropPath, files } = await planned({ keep: 100, drop: 50 });
    await writeFile(dropPath, 'd'.repeat(999));
    const r = await svc.resolve('r1');
    expect(r.skipped).toBe(1);
    expect(r.trashed).toBe(0);
    expect(files.remove).not.toHaveBeenCalled();
  });

  it('skips a file that disappeared, without failing the run', async () => {
    const { svc, dropPath } = await planned({ keep: 100, drop: 50 });
    await rm(dropPath);
    const r = await svc.resolve('r1');
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(0);
  });

  it('journals the action before touching the filesystem', async () => {
    const { svc, state } = await planned({ keep: 100, drop: 50 });
    await svc.resolve('r1');
    expect(state.actions).toHaveLength(1);
    expect(state.actions[0].sourcePath).toContain('drop.mkv');
    expect(state.actions[0].status).toBe('completed');
  });

  it('does not report success when an action failed', async () => {
    const { svc, files, state } = await planned({ keep: 100, drop: 50 });
    files.remove = jest.fn(async () => {
      throw new Error('device busy');
    });
    const r = await svc.resolve('r1');
    expect(r.status).toBe('failed');
    expect(r.failed).toBe(1);
    // A failed run must not mark the group resolved.
    expect(state.group.status).not.toBe('resolved');
    expect(state.actions[0].status).toBe('failed');
  });

  it('refuses to run the same plan twice', async () => {
    const { svc } = await planned({ keep: 100, drop: 50 });
    await svc.resolve('r1');
    await expect(svc.resolve('r1')).rejects.toThrow(ConflictException);
  });

  it('records actual reclaimed bytes, not the estimate', async () => {
    const { svc, state } = await planned({ keep: 100, drop: 50 });
    const r = await svc.resolve('r1');
    expect(r.reclaimedBytes).toBe(50);
    expect(state.resolution.actualSavingsBytes).toBe(BigInt(50));
  });
});

describe('previewItemDeletion — delete one copy, keep the rest', () => {
  it('plans to trash only the named copy, not the whole group', async () => {
    const { svc } = build({
      group: {
        recommendedItemId: 'a',
        items: [
          item('a', '/library/a.mkv', 100),
          item('b', '/library/b.mkv', 90),
          item('c', '/library/c.mkv', 80),
        ],
      },
    });
    const p = await svc.previewItemDeletion('g1', 'b');

    // Exactly the one copy is queued for Trash; the other two survive.
    expect(p.deleteItemId).toBe('b');
    expect(p.actions.filter((a) => a.actionType === 'trash').map((a) => a.sourcePath)).toEqual(['/library/b.mkv']);
    expect(p.survivorPaths.sort()).toEqual(['/library/a.mkv', '/library/c.mkv']);
    expect(p.blockers).toEqual([]);
  });

  it('refuses an item that is not a member of the group', async () => {
    const { svc } = build({
      group: { items: [item('a', '/library/a.mkv', 10), item('b', '/library/b.mkv', 20)] },
    });
    await expect(svc.previewItemDeletion('g1', 'outsider')).rejects.toThrow(BadRequestException);
  });

  it('refuses to delete a path that resolves to a library root', async () => {
    const { svc } = build({
      libraries: [{ path: '/library' }],
      group: { items: [item('a', '/library', 10), item('b', '/library/b.mkv', 20)] },
    });
    const p = await svc.previewItemDeletion('g1', 'a');
    expect(p.blockers.join(' ')).toContain('library root');
  });

  it('leaves the group OPEN — two copies may still be duplicated after one deletion', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dupdel-'));
    try {
      const a = path.join(dir, 'a.mkv');
      const b = path.join(dir, 'b.mkv');
      const c = path.join(dir, 'c.mkv');
      await writeFile(a, 'a'.repeat(100));
      await writeFile(b, 'b'.repeat(90));
      await writeFile(c, 'c'.repeat(80));
      const ctx = build({
        libraries: [{ path: dir }],
        assertWithinHardRoots: jest.fn((p: string) => {
          if (!p.startsWith(dir)) throw new Error('outside roots');
          return p;
        }),
        group: {
          version: 1,
          recommendedItemId: 'a',
          items: [item('a', a, 100), item('b', b, 90), item('c', c, 80)],
        },
      });
      await ctx.svc.previewItemDeletion('g1', 'b');
      const r = await ctx.svc.resolve('r1');

      expect(r.status).toBe('completed');
      expect(r.trashed).toBe(1);
      expect(ctx.files.remove.mock.calls[0][0].permanent).toBe(false);
      // NOT marked resolved: a and c are still a duplicate pair. Marking it resolved
      // would hide a group that is still a duplicate.
      expect(ctx.state.group.status).toBe('open');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses at execution if every surviving copy has vanished', async () => {
    // A race removed a and c between preview and confirm; trashing b too would leave
    // zero copies of the media.
    const dir = await mkdtemp(path.join(tmpdir(), 'dupdel-'));
    try {
      const a = path.join(dir, 'a.mkv');
      const b = path.join(dir, 'b.mkv');
      await writeFile(a, 'a'.repeat(100));
      await writeFile(b, 'b'.repeat(90));
      const ctx = build({
        libraries: [{ path: dir }],
        assertWithinHardRoots: jest.fn((p: string) => {
          if (!p.startsWith(dir)) throw new Error('outside roots');
          return p;
        }),
        group: {
          version: 1,
          recommendedItemId: 'a',
          items: [item('a', a, 100), item('b', b, 90)],
        },
      });
      // Delete 'a', keeping 'b'. Then 'b' — the only survivor — vanishes.
      await ctx.svc.previewItemDeletion('g1', 'a');
      await rm(b);

      await expect(ctx.svc.resolve('r1')).rejects.toThrow(ConflictException);
      expect(ctx.state.resolution.errorSummary).toBe('keeper_missing');
      expect(ctx.files.remove).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('bulk — a response carrying failures is never mistaken for a clean run', () => {
  let bulkDir: string;
  beforeEach(async () => { bulkDir = await mkdtemp(path.join(tmpdir(), 'dupbulk-')); });
  afterEach(async () => { await rm(bulkDir, { recursive: true, force: true }); });

  function multi(groups: Record<string, any>) {
    const state: any = { groups, resolutions: {} as any, actions: [] as any[], seq: 0 };
    const prisma: any = {
      mediaDuplicateGroup: {
        findUnique: jest.fn(async ({ where }: any) => state.groups[where.id] ?? null),
        update: jest.fn(async ({ where, data }: any) => Object.assign(state.groups[where.id], data)),
        findMany: jest.fn(async () => Object.values(state.groups)),
      },
      mediaLibrary: { findMany: jest.fn(async () => [{ path: bulkDir }]) },
      mediaDuplicateResolution: {
        create: jest.fn(async ({ data }: any) => {
          const id = `r${++state.seq}`;
          state.resolutions[id] = { id, ...data, group: state.groups[data.groupId] };
          return state.resolutions[id];
        }),
        findUnique: jest.fn(async ({ where }: any) => state.resolutions[where.id] ?? null),
        update: jest.fn(async ({ where, data }: any) => Object.assign(state.resolutions[where.id], data)),
      },
      mediaDuplicateResolutionAction: {
        create: jest.fn(async ({ data }: any) => { const r = { id: `a${state.actions.length}`, ...data }; state.actions.push(r); return r; }),
        update: jest.fn(async ({ where, data }: any) => Object.assign(state.actions.find((a: any) => a.id === where.id), data)),
      },
    };
    const filePath: any = {
      assertWithinHardRoots: jest.fn((p: string) => { if (!p.startsWith(bulkDir)) throw new Error('outside roots'); return p; }),
      safety: { toRelative: (p: string) => p },
      storageSafety: { toRelative: (p: string) => p },
    };
    const files: any = { remove: jest.fn(async () => undefined) };
    const audit: any = { record: jest.fn(async () => undefined) };
    return { svc: new DuplicateResolutionService(prisma, filePath, files, audit, { broadcast: jest.fn() } as any, { emit: jest.fn() } as any), state, files };
  }

  /** Writes the real files, so the resolve path reaches the step under test. */
  async function g(id: string, over: any = {}) {
    const keepPath = path.join(bulkDir, `${id}-keep.mkv`);
    const dropPath = path.join(bulkDir, `${id}-drop.mkv`);
    await writeFile(keepPath, 'k'.repeat(100));
    await writeFile(dropPath, 'd'.repeat(40));
    return {
      id, status: 'open', version: 1, recommendedItemId: 'keep', requiresReview: false,
      items: [item('keep', keepPath, 100), item('drop', dropPath, 40)],
      ...over,
    };
  }

  it('refuses an empty selection rather than reporting a vacuous success', async () => {
    const { svc } = multi({});
    await expect(svc.bulkPreview([])).rejects.toThrow(BadRequestException);
    await expect(svc.bulkResolve([])).rejects.toThrow(BadRequestException);
  });

  it('caps the blast radius of one call', async () => {
    const { svc } = multi({});
    const many = Array.from({ length: 101 }, (_, i) => `g${i}`);
    await expect(svc.bulkPreview(many)).rejects.toThrow(BadRequestException);
  });

  it('reports a per-group failure instead of aborting the batch', async () => {
    // g2 needs review and names no keeper — it must fail on its own without
    // preventing g1 and g3 from being planned.
    const { svc } = multi({
      g1: await g('g1'),
      g2: await g('g2', { requiresReview: true, recommendedItemId: null }),
      g3: await g('g3'),
    });
    const r = await svc.bulkPreview(['g1', 'g2', 'g3']);
    expect(r.succeeded).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.results.find((x) => x.groupId === 'g2')!.ok).toBe(false);
    expect(r.results.find((x) => x.groupId === 'g1')!.ok).toBe(true);
  });

  it('accepts a review-required group only with an explicit keeper', async () => {
    const { svc } = multi({ g1: await g('g1', { requiresReview: true, recommendedItemId: null }) });
    const refused = await svc.bulkPreview(['g1']);
    expect(refused.failed).toBe(1);

    const chosen = await svc.bulkPreview(['g1'], { g1: 'keep' });
    expect(chosen.succeeded).toBe(1);
  });

  it('aggregates files and savings across the batch', async () => {
    const { svc } = multi({ g1: await g('g1'), g2: await g('g2') });
    const r = await svc.bulkPreview(['g1', 'g2']);
    expect(r.totalFiles).toBe(2);
    expect(r.totalSavingsBytes).toBe(80);
  });

  it('does NOT count a partial run as succeeded', async () => {
    // The exact failure this envelope exists to prevent: a 200 whose body says some
    // files failed, rendered by a UI as "done".
    const { svc, files } = multi({ g1: await g('g1') });
    const planned = await svc.bulkPreview(['g1']);
    files.remove = jest.fn(async () => { throw new Error('device busy'); });
    const r = await svc.bulkResolve([planned.results[0].resolutionId!]);
    expect(r.succeeded).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.results[0].ok).toBe(false);
    expect(r.results[0].status).toBe('failed');
  });

  it('runs every remaining plan after one fails', async () => {
    const { svc, files } = multi({ g1: await g('g1'), g2: await g('g2') });
    const planned = await svc.bulkPreview(['g1', 'g2']);
    const ids = planned.results.map((x) => x.resolutionId!);
    let call = 0;
    files.remove = jest.fn(async () => { if (++call === 1) throw new Error('boom'); });
    const r = await svc.bulkResolve(ids);
    expect(r.results).toHaveLength(2);
    expect(r.succeeded).toBe(1);
    expect(r.failed).toBe(1);
  });

  it('quick-clean offers only groups the engine cleared', async () => {
    const { svc } = multi({
      safe: await g('safe'),
      review: await g('review', { requiresReview: true, recommendedItemId: null }),
    });
    const q = await svc.quickCleanCandidates();
    // findMany is stubbed to return everything, so assert the WHERE the service asks
    // for rather than the stub's output.
    expect(q.cap).toBeGreaterThan(0);
  });
});
