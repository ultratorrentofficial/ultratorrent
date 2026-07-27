import { FileEventBridge } from './file-event.bridge';

/**
 * The seam between file operations and media records.
 *
 * Two properties matter and they are easy to get backwards: relocation must run
 * BEFORE the reconciling scan, and the scan must be debounced.
 */
describe('FileEventBridge', () => {
  const build = () => {
    const order: string[] = [];
    const relocation: any = {
      recordMove: jest.fn(async () => { order.push('relocate'); }),
      recordDelete: jest.fn(async () => { order.push('relocate-delete'); }),
    };
    const scanner: any = {
      scanLibrary: jest.fn(async () => { order.push('scan'); return {}; }),
    };
    const prisma: any = {
      mediaLibrary: { findMany: jest.fn(async () => [{ id: 'lib', path: '/media/tv' }]) },
    };
    return { bridge: new FileEventBridge(relocation, prisma, scanner), relocation, scanner, prisma, order };
  };

  const moved = (from: string, to: string) => ({
    id: 'e1', eventKey: 'file.moved', occurredAt: '', payload: { from, to },
  }) as never;

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('relocates immediately and scans only after the debounce', async () => {
    const t = build();
    await t.bridge.handle(moved('/media/tv/a.mkv', '/media/tv/b.mkv'));
    // Identity first, and without waiting.
    expect(t.relocation.recordMove).toHaveBeenCalledWith('/media/tv/a.mkv', '/media/tv/b.mkv');
    expect(t.scanner.scanLibrary).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(6000);
    expect(t.scanner.scanLibrary).toHaveBeenCalledTimes(1);
    // Reversed, the scan would prune the stale row and cascade its enrichment
    // away before relocation could save it.
    expect(t.order).toEqual(['relocate', 'scan']);
  });

  it('collapses a burst into one scan per directory', async () => {
    // A bulk delete of forty files emits forty events.
    const t = build();
    for (let i = 0; i < 40; i += 1) {
      await t.bridge.handle(moved(`/media/tv/a${i}.mkv`, `/media/tv/b${i}.mkv`));
    }
    await jest.advanceTimersByTimeAsync(6000);
    expect(t.scanner.scanLibrary).toHaveBeenCalledTimes(1);
  });

  it('confines the scan to the touched directory', async () => {
    const t = build();
    await t.bridge.handle(moved('/media/tv/Show/a.mkv', '/media/tv/Show/b.mkv'));
    await jest.advanceTimersByTimeAsync(6000);
    // Third argument is the subPath — a whole-library walk would be a 500k-item
    // scan for one renamed file.
    expect(t.scanner.scanLibrary).toHaveBeenCalledWith('lib', undefined, '/media/tv/Show');
  });

  it('ignores directories outside every library', async () => {
    // The file manager spans every storage root; most hold no media.
    const t = build();
    await t.bridge.handle(moved('/downloads/tmp/a.mkv', '/downloads/tmp/b.mkv'));
    await jest.advanceTimersByTimeAsync(6000);
    expect(t.scanner.scanLibrary).not.toHaveBeenCalled();
  });

  it('scans both ends of a cross-folder move', async () => {
    const t = build();
    await t.bridge.handle(moved('/media/tv/A/x.mkv', '/media/tv/B/x.mkv'));
    await jest.advanceTimersByTimeAsync(6000);
    const dirs = t.scanner.scanLibrary.mock.calls.map((c: unknown[]) => c[2]);
    expect(dirs.sort()).toEqual(['/media/tv/A', '/media/tv/B']);
  });

  it('never throws at the bus when bookkeeping fails', async () => {
    // The file operation already happened; failing here neither undoes it nor
    // helps the caller.
    const t = build();
    t.relocation.recordMove.mockRejectedValue(new Error('db down'));
    await expect(t.bridge.handle(moved('/media/tv/a.mkv', '/media/tv/b.mkv'))).resolves.toBeUndefined();
  });

  it('survives a failing scan', async () => {
    const t = build();
    t.scanner.scanLibrary.mockRejectedValue(new Error('unreadable'));
    await t.bridge.handle(moved('/media/tv/a.mkv', '/media/tv/b.mkv'));
    await expect(jest.advanceTimersByTimeAsync(6000)).resolves.toBeUndefined();
  });
});
