import { MediaLibraryScanScheduler } from './media-library-scan-scheduler.service';

/** A library row shaped like the fields the scheduler reads. */
function lib(over: Partial<{ id: string; name: string; scanIntervalMinutes: number | null; lastScanAt: Date | null }>) {
  return { id: 'L', name: 'Lib', scanIntervalMinutes: 60, lastScanAt: null, ...over } as any;
}

function make(libraries: any[]) {
  const prisma = { mediaLibrary: { findMany: jest.fn().mockResolvedValue(libraries) } } as any;
  const processing = { processLibrary: jest.fn().mockResolvedValue({ libraryId: 'L', scanned: 0, identified: 0, metadataFetched: 0, artworkFetched: 0, processed: 0 }) };
  const scheduler = new MediaLibraryScanScheduler(prisma, processing as any);
  return { scheduler, prisma, processing };
}

describe('MediaLibraryScanScheduler', () => {
  const NOW = Date.now();
  const minsAgo = (m: number) => new Date(NOW - m * 60_000);

  it('scans libraries that opt in and are due; skips the rest', async () => {
    const { scheduler, processing } = make([
      lib({ id: 'never', scanIntervalMinutes: 60, lastScanAt: null }), // never scanned → due
      lib({ id: 'stale', scanIntervalMinutes: 30, lastScanAt: minsAgo(45) }), // elapsed → due
      lib({ id: 'fresh', scanIntervalMinutes: 60, lastScanAt: minsAgo(10) }), // within interval → skip
      lib({ id: 'manual-null', scanIntervalMinutes: null, lastScanAt: null }), // opt-out → skip
      lib({ id: 'manual-zero', scanIntervalMinutes: 0, lastScanAt: null }), // opt-out → skip
    ]);
    await scheduler.tick();
    const scanned = processing.processLibrary.mock.calls.map((c) => c[0]);
    expect(scanned.sort()).toEqual(['never', 'stale']);
  });

  it('isolates failures — one library throwing does not block the others', async () => {
    const { scheduler, processing } = make([lib({ id: 'a' }), lib({ id: 'b' })]);
    processing.processLibrary.mockRejectedValueOnce(new Error('boom'));
    await scheduler.tick();
    expect(processing.processLibrary).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no library is due', async () => {
    const { scheduler, processing } = make([lib({ scanIntervalMinutes: null })]);
    await scheduler.tick();
    expect(processing.processLibrary).not.toHaveBeenCalled();
  });

  it('does not overlap runs (re-entrancy guard)', async () => {
    const { scheduler, prisma, processing } = make([lib({ id: 'a' })]);
    let release!: () => void;
    processing.processLibrary.mockImplementation(() => new Promise<any>((res) => { release = () => res({}); }));
    const first = scheduler.tick(); // claims `running` synchronously, then blocks in processLibrary
    const second = scheduler.tick(); // sees `running` → early-returns
    await new Promise((r) => setImmediate(r)); // let `first` reach processLibrary
    release();
    await Promise.all([first, second]);
    expect(prisma.mediaLibrary.findMany).toHaveBeenCalledTimes(1);
    expect(processing.processLibrary).toHaveBeenCalledTimes(1);
  });
});
