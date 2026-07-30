/**
 * The file-by-file detail behind an undoable run.
 *
 * Reported as: the Undo list shows the events but not the original name or the
 * change, "so there's no way to analyze it". `undoableRuns()` returns counts —
 * enough to pick a run, not enough to judge one — while `source` and
 * `destination` had been recorded on every operation since the table existed.
 */
import { MediaService } from './media.service';

function build(rows: Array<Record<string, unknown>>, total = rows.length) {
  const captured: { where?: unknown; take?: number; orderBy?: unknown } = {};
  const prisma = {
    mediaRenameOperation: {
      count: jest.fn(async () => total),
      findMany: jest.fn(async (args: { where?: unknown; take?: number; orderBy?: unknown }) => {
        Object.assign(captured, args);
        return rows;
      }),
    },
  };
  // (prisma, config, settings, registry, audit, relocation, providers)
  const svc = new MediaService(
    prisma as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never,
  );
  return { svc, prisma, captured };
}

const row = (over: Record<string, unknown> = {}) => ({
  id: 'o1',
  source: '/media/The Fix (2024)/The Fix (2024) 1080p AAC.mp4',
  destination: '/media/The Fix (2024)/The Fix (2024) - 1080p.mp4',
  action: 'rename', kind: 'video', status: 'success', message: null, undoneAt: null,
  ...over,
});

describe('runOperations', () => {
  it('returns the old and new path for each operation', async () => {
    const { svc } = build([row()]);
    const out = await svc.runOperations('run-1');
    expect(out.operations[0].source).toContain('1080p AAC.mp4');
    expect(out.operations[0].destination).toContain('- 1080p.mp4');
  });

  it('scopes strictly to the run it was asked about', async () => {
    // Leaking another run's files into this list would misinform the very
    // decision the screen exists to support.
    const { svc, captured } = build([row()]);
    await svc.runOperations('run-1');
    expect(captured.where).toEqual({ runId: 'run-1' });
  });

  it('orders oldest first, so the list reads in the order it happened', async () => {
    const { svc, captured } = build([row()]);
    await svc.runOperations('run-1');
    expect(captured.orderBy).toEqual({ createdAt: 'asc' });
  });

  it('caps the rows it returns', async () => {
    // A run can cover a whole library; an uncapped read would ship it all to a
    // browser to render a summary nobody scrolls.
    const { svc, captured } = build([row()]);
    await svc.runOperations('run-1');
    expect(captured.take).toBe(500);
  });

  it('reports the true total and flags a truncated slice', async () => {
    /*
     * The load-bearing part. A capped list that claims to be the whole run tells
     * the operator a rename touched fewer files than it did.
     */
    const { svc } = build([row(), row({ id: 'o2' })], 900);
    const out = await svc.runOperations('run-1');
    expect(out.total).toBe(900);
    expect(out.truncated).toBe(true);
  });

  it('is not truncated when everything fits', async () => {
    const { svc } = build([row()], 1);
    const out = await svc.runOperations('run-1');
    expect(out.truncated).toBe(false);
  });

  it('serialises undoneAt as a string, and null when never undone', async () => {
    const { svc } = build([row(), row({ id: 'o2', undoneAt: new Date('2026-07-30T10:00:00Z') })]);
    const out = await svc.runOperations('run-1');
    expect(out.operations[0].undoneAt).toBeNull();
    expect(out.operations[1].undoneAt).toBe('2026-07-30T10:00:00.000Z');
  });
});
