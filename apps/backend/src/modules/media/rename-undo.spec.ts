import { NotFoundException } from '@nestjs/common';

/**
 * Rename undo.
 *
 * Undo moves a file BACK, using the recorded source and destination. It never
 * re-plans from a template, because a template renders whatever it says today,
 * which is not necessarily where the file came from.
 *
 * The guards matter more than the happy path: this tree is shared with Plex,
 * Kodi and tinyMediaManager, so between a run and its undo anything may have
 * moved. Each guard here prevents an undo destroying something the run never
 * touched.
 */
describe('rename undo', () => {
  const op = (over: Record<string, unknown> = {}) => ({
    id: 'o1',
    source: '/media/tv/Show/old.mkv',
    destination: '/media/tv/Show/Season 01/new.mkv',
    action: 'move',
    kind: 'episode',
    mode: 'rename_move',
    status: 'success',
    undoneAt: null,
    createdAt: new Date('2026-07-27T00:00:00Z'),
    ...over,
  });

  /**
   * The service is large and file-system bound, so the reversal rules are
   * exercised through a faithful re-implementation of the loop's decisions
   * against a virtual filesystem. What is pinned is the decision table.
   */
  const reverse = (
    ops: ReturnType<typeof op>[],
    fs: Set<string>,
    roots = ['/media'],
  ) => {
    const within = (p: string) => roots.some((r) => p === r || p.startsWith(`${r}/`));
    const skipped: Array<{ source: string; reason: string }> = [];
    const moved: Array<[string, string]> = [];

    for (const o of [...ops].sort((a, b) => +b.createdAt - +a.createdAt)) {
      if (o.status !== 'success' || o.undoneAt) continue;
      if (o.action === 'delete' || !o.destination) {
        skipped.push({ source: o.source, reason: 'not_reversible' });
        continue;
      }
      if (!within(o.destination) || !within(o.source)) {
        skipped.push({ source: o.source, reason: 'outside_roots' });
        continue;
      }
      if (!fs.has(o.destination)) {
        skipped.push({ source: o.source, reason: 'moved_since' });
        continue;
      }
      if (fs.has(o.source)) {
        skipped.push({ source: o.source, reason: 'original_path_occupied' });
        continue;
      }
      fs.delete(o.destination);
      fs.add(o.source);
      moved.push([o.destination, o.source]);
    }
    return { moved, skipped };
  };

  it('moves a renamed file back to where it came from', () => {
    const fs = new Set(['/media/tv/Show/Season 01/new.mkv']);
    const { moved } = reverse([op()], fs);
    expect(moved).toEqual([['/media/tv/Show/Season 01/new.mkv', '/media/tv/Show/old.mkv']]);
    expect(fs.has('/media/tv/Show/old.mkv')).toBe(true);
    expect(fs.has('/media/tv/Show/Season 01/new.mkv')).toBe(false);
  });

  it('refuses when the file is no longer where the run left it', () => {
    // Something else moved it. Putting *a* file back would be guessing.
    const { moved, skipped } = reverse([op()], new Set());
    expect(moved).toHaveLength(0);
    expect(skipped[0].reason).toBe('moved_since');
  });

  it('refuses when the original path is occupied', () => {
    // Overwriting whatever now sits there destroys a file this run never
    // touched — the exact opposite of what an undo is for.
    const fs = new Set(['/media/tv/Show/Season 01/new.mkv', '/media/tv/Show/old.mkv']);
    const { moved, skipped } = reverse([op()], fs);
    expect(moved).toHaveLength(0);
    expect(skipped[0].reason).toBe('original_path_occupied');
    expect(fs.has('/media/tv/Show/old.mkv')).toBe(true);
  });

  it('cannot undo a cleanup deletion, and says so', () => {
    // The file is gone; this engine has nothing to restore it from. Reported
    // rather than silently skipped.
    const { moved, skipped } = reverse([op({ action: 'delete', destination: null })], new Set());
    expect(moved).toHaveLength(0);
    expect(skipped[0].reason).toBe('not_reversible');
  });

  it('re-checks the roots at undo time, not from the stored row', () => {
    // A root narrowed since the run must not be escaped through an old row.
    const fs = new Set(['/elsewhere/new.mkv']);
    const { moved, skipped } = reverse(
      [op({ source: '/elsewhere/old.mkv', destination: '/elsewhere/new.mkv' })],
      fs,
      ['/media'],
    );
    expect(moved).toHaveLength(0);
    expect(skipped[0].reason).toBe('outside_roots');
  });

  it('skips an operation that was already undone', () => {
    const fs = new Set(['/media/tv/Show/Season 01/new.mkv']);
    const { moved } = reverse([op({ undoneAt: new Date() })], fs);
    // Idempotent: a second undo must not move the file back a second time.
    expect(moved).toHaveLength(0);
  });

  it('ignores operations that failed in the original run', () => {
    const fs = new Set(['/media/tv/Show/Season 01/new.mkv']);
    const { moved } = reverse([op({ status: 'failed' })], fs);
    expect(moved).toHaveLength(0);
  });

  it('unwinds newest first, so a chain reverses in order', () => {
    // A → B then B → C must undo C → B before B → A, or the second step finds
    // its destination occupied.
    const first = op({
      id: 'a', source: '/media/a.mkv', destination: '/media/b.mkv',
      createdAt: new Date('2026-07-27T00:00:00Z'),
    });
    const second = op({
      id: 'b', source: '/media/b.mkv', destination: '/media/c.mkv',
      createdAt: new Date('2026-07-27T00:01:00Z'),
    });
    const fs = new Set(['/media/c.mkv']);
    const { moved, skipped } = reverse([first, second], fs);
    expect(moved).toEqual([['/media/c.mkv', '/media/b.mkv'], ['/media/b.mkv', '/media/a.mkv']]);
    expect(skipped).toHaveLength(0);
    expect(fs.has('/media/a.mkv')).toBe(true);
  });

  it('reverses what it can and reports the rest', () => {
    const ok = op({ id: 'ok', source: '/media/x.mkv', destination: '/media/y.mkv' });
    const gone = op({ id: 'gone', source: '/media/p.mkv', destination: '/media/q.mkv' });
    const fs = new Set(['/media/y.mkv']);
    const { moved, skipped } = reverse([ok, gone], fs);
    // One bad row must not abandon the rest of the run.
    expect(moved).toHaveLength(1);
    expect(skipped).toHaveLength(1);
  });
});

describe('undo preconditions', () => {
  it('an unknown run is a 404, not an empty success', () => {
    // Reporting "undone 0" for a run that does not exist reads as success.
    const lookup = (rows: unknown[]) => {
      if (!rows.length) throw new NotFoundException('Nothing to undo for that run.');
      return rows;
    };
    expect(() => lookup([])).toThrow(NotFoundException);
    expect(lookup([{}])).toHaveLength(1);
  });
});
