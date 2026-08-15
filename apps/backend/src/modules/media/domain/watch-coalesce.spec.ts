import { coalesceScanTargets, isAtOrUnder } from './watch-coalesce';

const ROOT = '/downloads/Movies/HD Movies';

describe('isAtOrUnder', () => {
  it('matches a directory and anything beneath it', () => {
    expect(isAtOrUnder(`${ROOT}/Film (2024)`, ROOT)).toBe(true);
    expect(isAtOrUnder(ROOT, ROOT)).toBe(true);
  });

  it('does not match a sibling whose name merely starts the same', () => {
    // A prefix test says true here and would swallow a whole neighbouring tree.
    expect(isAtOrUnder('/downloads/Movies/HD Movies 2/Film', ROOT)).toBe(false);
  });

  it('ignores a trailing separator', () => {
    expect(isAtOrUnder(`${ROOT}/Film`, `${ROOT}/`)).toBe(true);
  });
});

describe('coalesceScanTargets', () => {
  it('collapses many events in one folder to a single scan', () => {
    // An unpack fires one event per extracted file; the folder is scanned once.
    const out = coalesceScanTargets([
      `${ROOT}/Film (2024)`, `${ROOT}/Film (2024)`, `${ROOT}/Film (2024)`,
    ]);
    expect(out).toEqual([`${ROOT}/Film (2024)`]);
  });

  it('drops a child when its parent is already being scanned', () => {
    /*
     * Creating a folder and filling it changes both. Scanning the parent already
     * walks the child, so keeping both would walk it twice.
     */
    const out = coalesceScanTargets([`${ROOT}/Film (2024)/Extras`, `${ROOT}/Film (2024)`]);
    expect(out).toEqual([`${ROOT}/Film (2024)`]);
  });

  it('keeps genuinely unrelated folders apart', () => {
    const out = coalesceScanTargets([`${ROOT}/A (2024)`, `${ROOT}/B (2025)`]);
    expect(out.sort()).toEqual([`${ROOT}/A (2024)`, `${ROOT}/B (2025)`]);
  });

  it('falls back to one common scan when a burst exceeds the cap', () => {
    /*
     * A library-wide reorganisation should cost one full scan, not hundreds of
     * partial ones — past some size the partial scan stops being an optimisation.
     */
    const many = Array.from({ length: 40 }, (_, i) => `${ROOT}/Film ${i}`);
    const out = coalesceScanTargets(many, { cap: 25, root: ROOT });
    expect(out).toEqual([ROOT]);
  });

  it('never climbs above the library root', () => {
    // Two libraries under one parent must not merge into a scan of the parent,
    // which would walk out of the library that was watched.
    const out = coalesceScanTargets(
      Array.from({ length: 40 }, (_, i) => `${ROOT}/x${i}`).concat(['/downloads/Movies/Other/y']),
      { cap: 25, root: ROOT },
    );
    expect(out).toEqual([ROOT]);
  });

  it('returns nothing for no events', () => {
    expect(coalesceScanTargets([])).toEqual([]);
  });
});
